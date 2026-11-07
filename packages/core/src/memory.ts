import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { chatTimestamp } from './time.js';
import { defineTool, type Tool } from './turn/tools.js';

export type MemoryScope =
  | { kind: 'group'; id: string; userId?: string }
  | { kind: 'user'; id: string };

const maxFileBytes = 8_192;
const recordedAtFooter =
  /\n\nRecorded at: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:Z|\+08:00)$/;
const scopeId = z.string().regex(/^\d{1,32}$/);
const filename = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_ -]{0,59}\.md$/u);

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class MarkdownMemory {
  private readonly root: string;
  private readonly pending = new Map<string, { markdown: string }>();
  private writes = Promise.resolve();
  private queued = 0;
  private closed = false;

  constructor(
    root: string,
    private readonly onError: (error: unknown) => void,
  ) {
    this.root = resolve(root);
  }

  tools(scope: MemoryScope): readonly Tool[] {
    const id = scopeId.parse(scope.id);
    const baseParts = [scope.kind, id];
    const memberId =
      scope.kind === 'group' ? scopeId.safeParse(scope.userId).data : undefined;
    const memberParts = memberId ? ['user', memberId, 'group', id] : undefined;
    const target = (
      memberParts ? z.enum(['group', 'user']) : z.literal(scope.kind)
    ).optional();
    const directory = (requested?: 'group' | 'user') => {
      const parts =
        requested === 'user' && memberParts ? memberParts : baseParts;
      return { parts, folder: join(this.root, ...parts) };
    };
    return [
      defineTool({
        name: 'list_memory',
        description:
          'List Markdown memory filenames within the selected scope.',
        input: z.object({ scope: target }),
        execute: async ({ scope: requested }) => {
          const { parts, folder } = directory(requested);
          const names = new Set<string>();
          try {
            await this.checkFolder(parts, false);
            for (const entry of await readdir(folder, {
              withFileTypes: true,
            })) {
              if (entry.isFile() && filename.safeParse(entry.name).success)
                names.add(entry.name);
            }
          } catch (error) {
            if (!hasCode(error, 'ENOENT')) return '记忆目录不可读。';
          }
          for (const path of this.pending.keys()) {
            if (!path.startsWith(`${folder}${sep}`)) continue;
            const name = path.slice(folder.length + 1);
            if (filename.safeParse(name).success) names.add(name);
          }
          return JSON.stringify([...names].sort());
        },
      }),
      defineTool({
        name: 'read_memory',
        description:
          'Read a Markdown memory file by name within the selected scope.',
        input: z.object({ scope: target, filename }),
        execute: async ({ scope: requested, filename: name }) => {
          const { parts, folder } = directory(requested);
          const path = join(folder, name);
          const staged = this.pending.get(path);
          if (staged) return staged.markdown;
          try {
            await this.checkFolder(parts, false);
            const file = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              if (!(await file.stat()).isFile()) return '记忆文件不可读。';
              const buffer = Buffer.alloc(maxFileBytes);
              const { bytesRead } = await file.read(buffer);
              return buffer.toString('utf8', 0, bytesRead);
            } finally {
              await file.close();
            }
          } catch (error) {
            return hasCode(error, 'ENOENT')
              ? '记忆文件不存在。'
              : '记忆文件不可读。';
          }
        },
      }),
      defineTool({
        name: 'write_memory',
        description:
          'Create or replace a Markdown memory file by topic. You MUST read an existing file before updating it and retain facts that still apply. Writes run in the background.',
        input: z.object({
          scope: target,
          filename,
          content: z.string().trim().min(1).max(8_192),
        }),
        execute: async ({ scope: requested, filename: name, content }) => {
          const { parts, folder } = directory(requested);
          const body = content.replace(recordedAtFooter, '');
          const markdown = `${body}\n\nRecorded at: ${chatTimestamp()}\n`;
          if (Buffer.byteLength(markdown) > maxFileBytes)
            return '文件过大，请精简或分成多份。';
          if (this.closed || this.queued >= 128)
            return '记忆写入队列暂不可用。';
          this.enqueue(parts, join(folder, name), markdown);
          return '记忆已进入后台写入队列。';
        },
      }),
    ];
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
  }

  private enqueue(
    parts: readonly string[],
    path: string,
    markdown: string,
  ): void {
    const entry = { markdown };
    this.pending.set(path, entry);
    this.queued += 1;
    this.writes = this.writes
      .then(async () => {
        await this.checkFolder(parts, true);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, markdown, { flag: 'wx', mode: 0o600 });
          await rename(temporary, path);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
      })
      .catch(this.onError)
      .finally(() => {
        this.queued -= 1;
        if (this.pending.get(path) === entry) this.pending.delete(path);
      });
  }

  private async checkFolder(
    parts: readonly string[],
    create: boolean,
  ): Promise<void> {
    let folder = this.root;
    if (create) await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const part of parts) {
      folder = join(folder, part);
      if (create) {
        await mkdir(folder, { mode: 0o700 }).catch((error: unknown) => {
          if (!hasCode(error, 'EEXIST')) throw error;
        });
      }
      if (!(await lstat(folder)).isDirectory())
        throw new Error('Invalid memory directory.');
    }
  }
}
