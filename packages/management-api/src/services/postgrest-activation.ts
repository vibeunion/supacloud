export class PostgrestActivationRolledBackError extends Error {
  readonly code = "POSTGREST_ACTIVATION_ROLLED_BACK";

  constructor(projectRef: string, activationError: unknown) {
    super(`PostgREST activation rolled back for ${projectRef}`, { cause: activationError });
    this.name = "PostgrestActivationRolledBackError";
  }
}

export class PostgrestActivationRollbackError extends AggregateError {
  readonly code = "POSTGREST_ACTIVATION_ROLLBACK_FAILED";

  constructor(projectRef: string, activationError: unknown, rollbackError: unknown) {
    super(
      [activationError, rollbackError],
      `PostgREST activation failed and the previous generation could not be restored for ${projectRef}`,
    );
    this.name = "PostgrestActivationRollbackError";
  }
}

export interface PostgrestActivationTransaction<T> {
  projectRef: string;
  previousPointerTarget: string | null;
  activate: () => Promise<T>;
  rollback: (previousPointerTarget: string | null) => Promise<void>;
}

export async function completePostgrestActivation<T>(
  transaction: PostgrestActivationTransaction<T>,
): Promise<T> {
  try {
    return await transaction.activate();
  } catch (activationError: unknown) {
    try {
      await transaction.rollback(transaction.previousPointerTarget);
    } catch (rollbackError: unknown) {
      throw new PostgrestActivationRollbackError(
        transaction.projectRef,
        activationError,
        rollbackError,
      );
    }
    throw new PostgrestActivationRolledBackError(transaction.projectRef, activationError);
  }
}
