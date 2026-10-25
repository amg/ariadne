/** What an error says, or the thrown value as text when it is not an error. */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
