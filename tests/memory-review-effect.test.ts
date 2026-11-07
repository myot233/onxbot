import { Cause, Effect, Exit } from 'effect';
import { expect, it, vi } from 'vitest';
import {
  type GroupMemoryBatch,
  MemoryReview,
  type MemoryReviewError,
  TurnRunner,
} from '../packages/core/src/index.js';
import type { ModelProvider } from '../packages/model/src/index.js';
import { sdkModel, sdkResult, textReply } from './helpers/model.js';

const batch: GroupMemoryBatch = {
  botId: '100',
  groupId: '42',
  lease: 'lease',
  throughId: '1',
  lines: [],
};

function fixture(model?: ModelProvider) {
  let step = 0;
  const memory = { tools: vi.fn(() => []), flush: vi.fn(async () => {}) };
  const store = {
    append: vi.fn(),
    claimDue: vi.fn(),
    renewLease: vi.fn(),
    finish: vi.fn(async (_batch: GroupMemoryBatch, _success: boolean) => {}),
  };
  const review = new MemoryReview(
    new TurnRunner(
      model ??
        sdkModel(() =>
          step++ === 0
            ? sdkResult(
                [
                  {
                    type: 'tool-call',
                    toolCallId: 'finish',
                    toolName: 'finish_review',
                    input: '{}',
                  },
                ],
                'tool-calls',
              )
            : sdkResult([{ type: 'text', text: 'REVIEW_COMPLETE' }]),
        ),
    ),
    memory,
    store,
  );
  return { review, memory, store };
}

function errors(exit: Exit.Exit<void, MemoryReviewError>): MemoryReviewError[] {
  if (Exit.isSuccess(exit)) throw new Error('Expected a failed review');
  return exit.cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => reason.error);
}

it('keeps the Promise entry point and checkpoints only after writes settle', async () => {
  const { review, memory, store } = fixture();
  await review.run(batch);
  expect(memory.flush).toHaveBeenCalledOnce();
  expect(store.finish).toHaveBeenCalledExactlyOnceWith(batch, true);
  expect(memory.flush.mock.invocationCallOrder[0]).toBeLessThan(
    store.finish.mock.invocationCallOrder[0] ?? 0,
  );
});

it('waits for pending writes before releasing a failed model batch', async () => {
  const failure = new Error('Provider unavailable');
  const { review, memory, store } = fixture({
    generate: async () => {
      throw failure;
    },
  });
  const drain = Promise.withResolvers<void>();
  memory.flush.mockImplementationOnce(() => drain.promise);
  const work = Effect.runPromiseExit(review.effect(batch));
  try {
    await vi.waitFor(() => expect(memory.flush).toHaveBeenCalledOnce());
    expect(store.finish).not.toHaveBeenCalled();
  } finally {
    drain.resolve();
  }
  expect(errors(await work)).toMatchObject([
    { stage: 'model', groupId: '42', cause: failure },
  ]);
  expect(store.finish).toHaveBeenCalledExactlyOnceWith(batch, false);
});

it('rejects an unacknowledged review without deleting its messages', async () => {
  const { review, store } = fixture({
    generate: async () => textReply('REVIEW_COMPLETE'),
  });
  expect(
    errors(await Effect.runPromiseExit(review.effect(batch))),
  ).toMatchObject([{ stage: 'completion' }]);
  expect(store.finish).toHaveBeenCalledExactlyOnceWith(batch, false);
});

it('retains the batch when a memory write fails before checkpointing', async () => {
  const { review, memory, store } = fixture();
  const failure = new Error('Disk full');
  memory.flush.mockRejectedValueOnce(failure);
  expect(
    errors(await Effect.runPromiseExit(review.effect(batch))),
  ).toMatchObject([{ stage: 'flush', cause: failure }]);
  expect(store.finish).toHaveBeenCalledExactlyOnceWith(batch, false);
});

it('releases a failed checkpoint for the database scheduler to retry', async () => {
  const { review, store } = fixture();
  const failure = new Error('Database unavailable');
  store.finish.mockRejectedValueOnce(failure);
  expect(
    errors(await Effect.runPromiseExit(review.effect(batch))),
  ).toMatchObject([{ stage: 'checkpoint', cause: failure }]);
  expect(store.finish.mock.calls).toEqual([
    [batch, true],
    [batch, false],
  ]);
});

it('preserves model, drain, and release failures together', async () => {
  const { review, memory, store } = fixture({
    generate: async () => {
      throw new Error('Model failed');
    },
  });
  memory.flush.mockRejectedValueOnce(new Error('Drain failed'));
  store.finish.mockRejectedValueOnce(new Error('Release failed'));
  const failures = errors(await Effect.runPromiseExit(review.effect(batch)));
  expect(failures.map((error) => error.stage)).toEqual([
    'model',
    'flush',
    'release',
  ]);
  expect(store.finish).toHaveBeenCalledExactlyOnceWith(batch, false);
});

it('lets an in-flight Promise settle before interruption releases the batch', async () => {
  const model = Promise.withResolvers<ReturnType<typeof textReply>>();
  const started = Promise.withResolvers<void>();
  const { review, memory, store } = fixture({
    generate: async () => {
      started.resolve();
      return model.promise;
    },
  });
  const controller = new AbortController();
  const work = Effect.runPromiseExit(review.effect(batch), {
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  expect(memory.flush).not.toHaveBeenCalled();
  expect(store.finish).not.toHaveBeenCalled();
  model.resolve(textReply('REVIEW_COMPLETE'));
  const exit = await work;
  if (Exit.isSuccess(exit)) throw new Error('Expected interruption');
  expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(memory.flush).toHaveBeenCalledOnce();
  expect(store.finish).toHaveBeenCalledExactlyOnceWith(batch, false);
});

it('does not release an already committed checkpoint after interruption', async () => {
  const { review, store } = fixture();
  const checkpoint = Promise.withResolvers<void>();
  store.finish.mockImplementationOnce(() => checkpoint.promise);
  const controller = new AbortController();
  const work = Effect.runPromiseExit(review.effect(batch), {
    signal: controller.signal,
  });
  try {
    await vi.waitFor(() =>
      expect(store.finish).toHaveBeenCalledWith(batch, true),
    );
    controller.abort();
  } finally {
    checkpoint.resolve();
  }
  await work;
  expect(store.finish).toHaveBeenCalledExactlyOnceWith(batch, true);
});

it('allocates completion and checkpoint state for each execution', async () => {
  const { review, store } = fixture();
  const program = review.effect(batch);
  expect(store.finish).not.toHaveBeenCalled();
  await Effect.runPromise(program);
  // This fixture only acknowledges the first run through finish_review.
  expect(errors(await Effect.runPromiseExit(program))).toMatchObject([
    { stage: 'completion' },
  ]);
  expect(store.finish.mock.calls).toEqual([
    [batch, true],
    [batch, false],
  ]);
});
