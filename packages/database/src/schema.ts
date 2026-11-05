import type { FeedbackLabel, GroupDecision, GroupLine } from '@onxbot/core';
import type { ConversationMessage } from '@onxbot/model';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface Database {
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
