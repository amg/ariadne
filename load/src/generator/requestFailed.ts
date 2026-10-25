/** A request that got an answer other than the one it needed. */
export class RequestFailed extends Error {
  readonly status: number;

  constructor(what: string, status: number) {
    super(`${what} answered ${status}`);
    this.status = status;
  }
}
