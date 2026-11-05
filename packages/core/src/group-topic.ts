import type { GroupLine } from './group-chat.js';

export interface ScheduledGroupTopic {
  groupId: string;
  activityVersion: string;
  context: GroupLine[];
}

export interface GroupTopicStore {
  append(
    botId: string,
    groupId: string,
    line: GroupLine,
    human: boolean,
  ): Promise<void>;
  claimDue(
    botId: string,
    groupIds: readonly string[],
  ): Promise<ScheduledGroupTopic[]>;
  isCurrent(botId: string, topic: ScheduledGroupTopic): Promise<boolean>;
}
