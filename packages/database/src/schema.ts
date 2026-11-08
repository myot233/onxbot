import type { FeedbackLabel, GroupDecision, GroupLine } from '@onxbot/core';
import type { ConversationMessage, Trace, TraceEvent } from '@onxbot/model';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface Database {
  model_traces: {
    id: Generated<number>;
    session: string;
    owner_id: string;
    lease_until: Timestamp;
    started_at: Timestamp;
    finished_at: Timestamp | null;
    status: Generated<Trace['status']>;
    truncated: Generated<boolean>;
    event_count: Generated<number>;
  };
  model_trace_events: {
    trace_id: number;
    sequence: number;
    phase: TraceEvent['phase'];
    content: string;
  };
  group_memory_schedules: {
    bot_id: string;
    group_id: string;
    next_run_at: Timestamp;
    lease: string | null;
    lease_until: Timestamp | null;
  };
  group_memory_messages: {
    id: Generated<string>;
    bot_id: string;
    group_id: string;
    line: JSONColumnType<GroupLine>;
  };
  group_topic_schedules: {
    bot_id: string;
    group_id: string;
    next_run_at: Timestamp;
    last_activity_at: Timestamp | null;
    activity_version: Generated<string>;
    consumed_version: Generated<string>;
    context: ColumnType<GroupLine[], string | undefined, string>;
  };
  group_decisions: {
    id: Generated<string>;
    group_id: string;
    message_id: string;
    reply_id: string | null;
    policy: string;
    trigger: GroupDecision['trigger'];
    outcome: GroupDecision['outcome'];
    context: JSONColumnType<
      { speaker: number; text: string; quote?: string }[]
    >;
    reply: string | null;
    created_at: Timestamp;
  };
  group_ratings: {
    decision_id: string;
    voter_id: string;
    label: FeedbackLabel;
  };
  conversations: {
    id: Generated<string>;
    platform: string;
    bot_id: string;
    channel_id: string;
    user_id: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  conversation_turns: {
    id: Generated<string>;
    conversation_id: string;
    messages: JSONColumnType<ConversationMessage[]>;
    created_at: Timestamp;
  };
}
