import type { GroupDecision } from './group-chat.js';

export const feedbackLabels = ['good', 'interrupt', 'wrong'] as const;
export type FeedbackLabel = (typeof feedbackLabels)[number];

export interface GroupFeedback {
  record(
    sample: GroupDecision & {
      groupId: string;
      messageId: string;
      replyId?: string;
    },
  ): Promise<void>;
  rate(
    groupId: string,
    replyId: string,
    voterId: string,
    label: FeedbackLabel,
  ): Promise<boolean>;
}
