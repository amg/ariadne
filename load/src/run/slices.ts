/**
 * Splits `users` into `generators` slices of consecutive users, as even as
 * they can be: the first slices take the one extra user each when the
 * users do not divide. Generators are numbered from 0.
 */
export function sliceUsers(input: { users: number; generators: number }) {
  const { users, generators } = input;
  const each = Math.floor(users / generators);
  const extra = users % generators;
  return Array.from({ length: generators }, (_, index) => ({
    generator: index,
    firstUser: index * each + Math.min(index, extra),
    userCount: each + (index < extra ? 1 : 0),
  }));
}
