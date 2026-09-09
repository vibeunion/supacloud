import type { CommandIdentity, DurableCommandReceipt } from "./receipts";

export interface OperationReference extends CommandIdentity {
  command: string;
  operationId: string;
}
export interface StoredCommand {
  receipt: DurableCommandReceipt<unknown>;
  kind: "transactional" | "external";
  inputFingerprint: string;
  inputPayload: string | null;
}
export interface CommandStoreSession<Transaction> {
  readonly transaction: Transaction;
  lock(reference: OperationReference): Promise<void>;
  read(reference: OperationReference): Promise<StoredCommand | null>;
  insert(record: StoredCommand): Promise<void>;
  confirm(reference: OperationReference, result: unknown): Promise<void>;
  markUnknown(reference: OperationReference): Promise<void>;
  audit(reference: OperationReference, event: string, details: unknown): Promise<void>;
  completeAudit(reference: OperationReference): Promise<void>;
}
export interface CommandStore<Transaction> {
  /** One atomic connection. A failed commit must not be reported as a denial. */
  transaction<T>(run: (session: CommandStoreSession<Transaction>) => Promise<T>): Promise<T>;
}

export interface RecoveryClaim extends OperationReference {
  leaseId: string;
  createdAt: number;
  attempts: number;
}
export interface RecoveryScope {
  tenantId: string;
  commands: readonly string[];
}
export interface CommandRecoveryStore {
  claim(scope: RecoveryScope & { now: number; limit: number; leaseMs: number }): Promise<RecoveryClaim[]>;
  release(claim: RecoveryClaim, nextAttemptAt: number): Promise<void>;
  /** Retains receipt and fingerprint; never redacts pending or unaudited operations. */
  redactCompleted(scope: RecoveryScope & { before: number; limit: number }): Promise<number>;
}
