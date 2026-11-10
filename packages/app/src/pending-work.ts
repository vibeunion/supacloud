/** Transport-neutral work registry. No Angular, SDK, or injector import. */
export {
  PendingWorkRegistry,
  PendingWorkTimeoutError,
  PendingWorkCapacityError,
  createPendingWorkRegistry,
} from "./pending_work.js";
export type {
  WorkKind,
  WorkDescription,
  WorkOwner,
  WorkRegistryOptions,
  WorkWaitOptions,
  PendingWorkSnapshot,
} from "./pending_work.js";
