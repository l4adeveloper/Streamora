export const CLASS_POLL_LIMITS = {
  minOptions: 2,
  maxOptions: 6,
  maxQuestionLength: 300,
  maxOptionLength: 150,
} as const;

export type ClassPollStatus = "OPEN" | "CLOSED";

export interface ClassPollOption {
  id: string;
  text: string;
  count: number;
}

export interface ClassPollUpdated {
  sessionId: string;
  pollId: string;
  question: string;
  options: ClassPollOption[];
  status: ClassPollStatus;
  totalVotes: number;
  /** Monotonic decimal bigint string scoped to one poll. */
  version: string;
}

export interface ClassPoll extends Omit<ClassPollUpdated, "pollId"> {
  id: string;
  myOptionId: string | null;
}

export interface CreateClassPollRequest {
  question: string;
  options: { text: string }[];
}

export interface ClassPollVoteRequest {
  optionId: string;
}

export interface ClassPollResponse {
  poll: ClassPoll;
}
