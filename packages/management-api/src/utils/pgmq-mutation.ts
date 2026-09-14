export class PgmqMutationError extends Error {
  readonly mutationMayHaveApplied = true;

  constructor() {
    super("Queue mutation could not be confirmed");
    this.name = "PgmqMutationError";
  }
}
