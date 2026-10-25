/** A slice of consecutive users: where it starts and how many it holds. */
type UserSlice = { firstUser: number; userCount: number };

/** The number of the last user in the slice. */
export function lastUserOf(slice: UserSlice) {
  return slice.firstUser + slice.userCount - 1;
}

/** The users of a slice as a range in words, such as "3 to 5". */
export function formattedUserRange(slice: UserSlice) {
  return `${slice.firstUser} to ${lastUserOf(slice)}`;
}
