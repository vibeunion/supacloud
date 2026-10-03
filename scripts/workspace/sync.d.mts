export interface SyncOutput {
  file: string;
  content: string;
  summary?: readonly string[];
}

export interface SyncChange {
  file: string;
  before: string | null;
  after: string;
  changed: boolean;
}

export interface SyncPlan {
  schemaVersion: 1;
  kind: 'supacloud-reviewed-sync';
  clean: boolean;
  changes: SyncChange[];
}

export interface AppliedSyncPlan extends SyncPlan {
  applied: string[];
}

export function digest(text: string): string;
export function syncPlan(root: string, outputs: readonly SyncOutput[]): SyncPlan;
export function applySyncPlan(
  root: string,
  plan: SyncPlan,
  outputs: readonly SyncOutput[],
  options?: { replace?: (temporary: string, destination: string) => void },
): AppliedSyncPlan;
