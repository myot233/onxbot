import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface Database {
  conversations: {
    id: Generated<string>;
    platform: string;
    bot_id: string;
    channel_id: string;
    user_id: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  messages: {
    id: Generated<string>;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: Timestamp;
  };
}
