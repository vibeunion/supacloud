import type {
  CommandIdentity,
  DurableCommandReceipt,
  ValidatedCommandIdentity,
} from "./receipts.js";
import type { CommandName, OperationId } from "./identity.js";

export interface OperationReference extends CommandIdentity {
  command: string;
  operationId: string;
}
export interface ValidatedOperationReference extends ValidatedCommandIdentity {
  command: CommandName;
  operationId: OperationId;
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

export interface RecoveryScope {
  tenantId: string;
  commands: readonly string[];
}
export interface RecoveryClaim extends OperationReference {
  leaseId: string;
  createdAt: number;
  attempts: number;
}
export interface CommandRecoveryStore {
  claim(options: RecoveryScope & { now: number; limit: number; leaseMs: number }): Promise<RecoveryClaim[]>;
  release(claim: RecoveryClaim, retryAt: number): Promise<void>;
  redactCompleted(scope: RecoveryScope & { before: number; limit: number }): Promise<number>;
}
export interface CommandRetentionStore {
  /** Retains receipt and fingerprint; never redacts pending or unaudited operations. */
  redactCompleted(scope: RecoveryScope & { before: number; limit: number }): Promise<number>;
}
