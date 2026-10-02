/** Transport-neutral runtime diagnostics. No Angular, SDK, or application root import. */
export { PendingWorkRegistry, PendingWorkTimeoutError, createPendingWorkRegistry } from "./pending_work.js";
export type { WorkKind, WorkDescription, WorkOwner, WorkRegistryOptions, WorkWaitOptions, PendingWorkSnapshot } from "./pending_work.js";
