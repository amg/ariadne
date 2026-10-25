/** One line of a graph as CloudWatch returned it: what it was asked for, and a value per minute. */
export type Series = {
  /** The label the query gave it, which says what it measures. */
  label: string;
  points: readonly { at: Date; value: number }[];
};
