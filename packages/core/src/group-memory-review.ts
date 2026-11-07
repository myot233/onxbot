import type { GroupLine } from './group-chat.js';

export interface GroupMemoryBatch {
  botId: string;
  groupId: string;
  lease: string;
  throughId: string;
  lines: GroupLine[];
}

export interface GroupMemoryReviewStore {
  append(botId: string, groupId: string, line: GroupLine): Promise<void>;
  claimDue(
    botId: string,
    groupIds: readonly string[],
  ): Promise<GroupMemoryBatch | undefined>;
  renewLease(batch: GroupMemoryBatch): Promise<boolean>;
  finish(batch: GroupMemoryBatch, success: boolean): Promise<void>;
}
