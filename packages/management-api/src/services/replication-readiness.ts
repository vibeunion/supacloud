export interface ReplicationSettingRow {
  name: unknown;
  setting: unknown;
  pending_restart?: unknown;
}

export interface ReplicationSlotRow {
  slot_type?: unknown;
  active?: unknown;
  wal_status?: unknown;
  retained_wal_bytes?: unknown;
  unconfirmed_wal_bytes?: unknown;
  safe_wal_size?: unknown;
  conflicting?: unknown;
  invalidation_reason?: unknown;
}

export interface ReplicationPublicationRow {
  pubname?: unknown;
  puballtables?: unknown;
  pubinsert?: unknown;
  pubupdate?: unknown;
  pubdelete?: unknown;
  table_count?: unknown;
  replica_identity_missing_table_count?: unknown;
}

export interface PowerSyncReadiness {
  provider: "powersync";
  ready: boolean;
  blockers: string[];
  warnings: string[];
  checks: {
    wal_level: { ok: boolean; actual: string };
    wal_senders: {
      ok: boolean;
      configured: number;
      active: number;
      free: number;
    };
    replication_slots: {
      ok: boolean;
      configured: number;
      used: number;
      free: number;
      logical: number;
      active_logical: number;
    };
    logical_slot_health: {
      ok: boolean;
      invalid: number;
      wal_unreserved: number;
      wal_lost: number;
      safe_wal_exhausted: number;
      max_retained_wal_bytes: string;
      max_unconfirmed_wal_bytes: string;
      min_safe_wal_bytes: string | null;
    };
    wal_retention: {
      setting: string;
      bounded: boolean | null;
    };
    pending_restart: {
      ok: boolean;
      settings: string[];
    };
    publications: {
      ok: boolean;
      count: number;
      published_tables: number;
      powersync: {
        present: boolean;
        all_tables: boolean;
        table_count: number;
        publishes_insert: boolean;
        publishes_update: boolean;
        publishes_delete: boolean;
        replica_identity_missing_tables: number;
      };
    };
  };
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function trueValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function nonNegativeBigInt(value: unknown): bigint | null {
  const normalized = String(value ?? "");
  if (!/^\d+$/.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function extremeBigIntString(
  values: readonly bigint[],
  pick: (left: bigint, right: bigint) => bigint,
): string | null {
  return values.length > 0 ? values.reduce(pick).toString() : null;
}

function capacityReadiness(
  settings: ReadonlyMap<string, string>,
  slots: readonly ReplicationSlotRow[],
  activeWalSendersInput: unknown,
) {
  const walLevel = settings.get("wal_level") || "unknown";
  const maxWalSenders = nonNegativeInteger(settings.get("max_wal_senders"));
  const activeWalSenders = nonNegativeInteger(activeWalSendersInput);
  const freeWalSenders = Math.max(0, maxWalSenders - activeWalSenders);
  const maxSlots = nonNegativeInteger(settings.get("max_replication_slots"));
  const logicalSlots = slots.filter((slot) => slot.slot_type === "logical");
  const freeSlots = Math.max(0, maxSlots - slots.length);
  const blockers: string[] = [];
  if (walLevel !== "logical") blockers.push("WAL_LEVEL_NOT_LOGICAL");
  if (maxWalSenders < 1) blockers.push("WAL_SENDERS_DISABLED");
  else if (freeWalSenders < 1) blockers.push("NO_FREE_WAL_SENDER");
  if (maxSlots < 1) blockers.push("REPLICATION_SLOTS_DISABLED");
  else if (freeSlots < 1) blockers.push("NO_FREE_REPLICATION_SLOT");
  return {
    blockers,
    walLevel: { ok: walLevel === "logical", actual: walLevel },
    walSenders: {
      ok: maxWalSenders > 0 && freeWalSenders > 0,
      configured: maxWalSenders,
      active: activeWalSenders,
      free: freeWalSenders,
    },
    replicationSlots: {
      ok: maxSlots > 0 && freeSlots > 0,
      configured: maxSlots,
      used: slots.length,
      free: freeSlots,
      logical: logicalSlots.length,
      active_logical: logicalSlots.filter((slot) => trueValue(slot.active)).length,
    },
  };
}

function logicalSlotReadiness(slots: readonly ReplicationSlotRow[]) {
  const logicalSlots = slots.filter((slot) => slot.slot_type === "logical");
  const invalid = logicalSlots.filter((slot) =>
    String(slot.invalidation_reason ?? "") !== ""
    || String(slot.wal_status ?? "") === "lost"
    || trueValue(slot.conflicting)
  );
  const unreserved = logicalSlots.filter((slot) => slot.wal_status === "unreserved");
  const lost = logicalSlots.filter((slot) => slot.wal_status === "lost");
  const safeWalExhausted = logicalSlots.filter(
    (slot) => nonNegativeBigInt(slot.safe_wal_size) === 0n,
  );
  const retained = logicalSlots.flatMap((slot) => {
    const bytes = nonNegativeBigInt(slot.retained_wal_bytes);
    return bytes === null ? [] : [bytes];
  });
  const unconfirmed = logicalSlots.flatMap((slot) => {
    const bytes = nonNegativeBigInt(slot.unconfirmed_wal_bytes);
    return bytes === null ? [] : [bytes];
  });
  const safeWalSizes = logicalSlots.flatMap((slot) => {
    const bytes = nonNegativeBigInt(slot.safe_wal_size);
    return bytes === null ? [] : [bytes];
  });
  const warnings: string[] = [];
  if (invalid.length > 0) warnings.push("INVALID_LOGICAL_SLOTS");
  if (unreserved.length > 0) warnings.push("LOGICAL_SLOT_WAL_UNRESERVED");
  if (safeWalExhausted.length > 0) warnings.push("LOGICAL_SLOT_SAFE_WAL_EXHAUSTED");
  return {
    warnings,
    check: {
      ok: invalid.length === 0 && unreserved.length === 0 && safeWalExhausted.length === 0,
      invalid: invalid.length,
      wal_unreserved: unreserved.length,
      wal_lost: lost.length,
      safe_wal_exhausted: safeWalExhausted.length,
      max_retained_wal_bytes: extremeBigIntString(
        retained,
        (left, right) => left > right ? left : right,
      ) ?? "0",
      max_unconfirmed_wal_bytes: extremeBigIntString(
        unconfirmed,
        (left, right) => left > right ? left : right,
      ) ?? "0",
      min_safe_wal_bytes: extremeBigIntString(
        safeWalSizes,
        (left, right) => left < right ? left : right,
      ),
    },
  };
}

function walRetentionReadiness(settings: ReadonlyMap<string, string>) {
  const setting = settings.get("max_slot_wal_keep_size") ?? "unknown";
  const warnings: string[] = [];
  if (setting === "-1") warnings.push("SLOT_WAL_KEEP_SIZE_UNBOUNDED");
  if (setting === "0") warnings.push("SLOT_WAL_KEEP_SIZE_ZERO");
  return {
    warnings,
    check: {
      setting,
      bounded: setting === "unknown" ? null : setting !== "-1",
    },
  };
}

function pendingRestartReadiness(settings: readonly ReplicationSettingRow[]) {
  const pending = settings
    .filter((setting) => trueValue(setting.pending_restart))
    .map((setting) => String(setting.name))
    .sort();
  return {
    warnings: pending.length > 0 ? ["REPLICATION_SETTINGS_PENDING_RESTART"] : [],
    check: { ok: pending.length === 0, settings: pending },
  };
}

function publicationReadiness(publications: readonly ReplicationPublicationRow[]) {
  const publishedTables = publications.reduce(
    (total, publication) => total + nonNegativeInteger(publication.table_count),
    0,
  );
  const publication = publications.find(
    (candidate) => String(candidate.pubname).toLowerCase() === "powersync",
  );
  const tableCount = nonNegativeInteger(publication?.table_count);
  const missingIdentity = nonNegativeInteger(
    publication?.replica_identity_missing_table_count,
  );
  const publishesInsert = trueValue(publication?.pubinsert);
  const publishesUpdate = trueValue(publication?.pubupdate);
  const publishesDelete = trueValue(publication?.pubdelete);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (publishedTables < 1) blockers.push("NO_PUBLISHED_TABLES");
  if (!publication) blockers.push("POWERSYNC_PUBLICATION_MISSING");
  else {
    if (tableCount < 1) blockers.push("POWERSYNC_PUBLICATION_EMPTY");
    if (!publishesInsert || !publishesUpdate || !publishesDelete) {
      blockers.push("POWERSYNC_PUBLICATION_DML_INCOMPLETE");
    }
    if (missingIdentity > 0) blockers.push("POWERSYNC_REPLICA_IDENTITY_INCOMPLETE");
    if (trueValue(publication.puballtables)) warnings.push("POWERSYNC_PUBLICATION_ALL_TABLES");
  }
  return {
    blockers,
    warnings,
    check: {
      ok: Boolean(publication)
        && tableCount > 0
        && publishesInsert
        && publishesUpdate
        && publishesDelete
        && missingIdentity === 0,
      count: publications.length,
      published_tables: publishedTables,
      powersync: {
        present: Boolean(publication),
        all_tables: trueValue(publication?.puballtables),
        table_count: tableCount,
        publishes_insert: publishesInsert,
        publishes_update: publishesUpdate,
        publishes_delete: publishesDelete,
        replica_identity_missing_tables: missingIdentity,
      },
    },
  };
}

export function summarizePowerSyncReadiness(input: {
  settings: readonly ReplicationSettingRow[];
  slots: readonly ReplicationSlotRow[];
  publications: readonly ReplicationPublicationRow[];
  activeWalSenders: unknown;
}): PowerSyncReadiness {
  const settings = new Map(
    input.settings.map((row) => [String(row.name), String(row.setting)]),
  );
  const capacity = capacityReadiness(settings, input.slots, input.activeWalSenders);
  const slotHealth = logicalSlotReadiness(input.slots);
  const walRetention = walRetentionReadiness(settings);
  const pendingRestart = pendingRestartReadiness(input.settings);
  const publications = publicationReadiness(input.publications);
  const blockers = [...capacity.blockers, ...publications.blockers];
  const warnings = [
    ...publications.warnings,
    ...slotHealth.warnings,
    ...walRetention.warnings,
    ...pendingRestart.warnings,
  ];

  return {
    provider: "powersync",
    ready: blockers.length === 0,
    blockers,
    warnings,
    checks: {
      wal_level: capacity.walLevel,
      wal_senders: capacity.walSenders,
      replication_slots: capacity.replicationSlots,
      logical_slot_health: slotHealth.check,
      wal_retention: walRetention.check,
      pending_restart: pendingRestart.check,
      publications: publications.check,
    },
  };
}
