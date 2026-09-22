// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import {
  InvalidPostgrestObservationError, InvalidPostgrestStatusRecordError,
  parsePostgrestObservation, parsePostgrestStatusRecord, PostgrestObservationConflictError,
  InvalidPostgrestObservationReceiptError, parsePostgrestObservationReceipt,
  InvalidPostgrestRuntimeTargetError, parsePostgrestRuntimeTarget,
} from "../../src/services/tenant-runtime-status-record";
import { withNativePostgres } from "../helpers/native-postgres";

const instant = "2026-09-10T00:00:00.000Z";
const base = { ref: "fixture", status: "active", postgrest_desired: "running", updated_at: instant, postgrest_row_revision: "1" };
const invalidObservations: unknown[] = [
  null, {}, [], { actual: "running", health: "healthy" },
  { actual: "unknown", health: "unknown", last_error: null },
  { actual: "running", health: "degraded", last_error: null },
  { actual: "running", health: "healthy", last_error: "contradictory error" },
  { actual: "stopped", health: "healthy", last_error: null },
  { actual: "stopped", health: "unknown", last_error: "contradictory error" },
  { actual: "starting", health: "healthy", last_error: null },
  { actual: "error", health: "unhealthy", last_error: 1 },
];
const validUnit = "supacloud-pgrst@fixture";
const invalidTargets: Array<{ port: unknown; unit: unknown }> = [
  ...[undefined, null, 0, -1, 1.5, 65536, NaN, Infinity, "54321"].map(port => ({ port, unit: validUnit })),
  ...[undefined, null, 1, "", "supacloud-pgrst@other", `${validUnit}.service`, `${validUnit}\n`]
    .map(unit => ({ port: 54321, unit })),
];

test("runtime targets require numeric ports and the current project's canonical unit", () => {
  for (const port of [1, 54321, 65535]) {
    expect(parsePostgrestRuntimeTarget(port, validUnit, "fixture")).toEqual({ port, unit: validUnit });
  }
  for (const { port, unit } of invalidTargets) {
    expect(() => parsePostgrestRuntimeTarget(port, unit, "fixture")).toThrow(InvalidPostgrestRuntimeTargetError);
  }
  for (const ref of ["", "../fixture", "fixture\n", "x".repeat(129)]) {
    expect(() => parsePostgrestRuntimeTarget(54321, `supacloud-pgrst@${ref}`, ref))
      .toThrow(InvalidPostgrestRuntimeTargetError);
  }
  let coercions = 0;
  const object = { toString() { coercions++; return validUnit; } };
  expect(() => parsePostgrestRuntimeTarget(54321, object, "fixture")).toThrow(InvalidPostgrestRuntimeTargetError);
  expect(coercions).toBe(0);
});

test("observation receipts bind persisted fields and require confirmed database timestamps", () => {
  const expected = { desired: "running", actual: "running", health: "healthy", port: 54321, last_error: null } as const;
  const receipt = {
    ...base, deleted_at: null, postgrest_actual: "running", postgrest_health: "healthy",
    postgrest_port: 54321, postgrest_last_error: null, postgrest_updated_at: instant,
    observation_time_matches: true,
  };
  expect(parsePostgrestObservationReceipt(receipt, "fixture", expected))
    .toEqual({ updatedAt: instant, lastReconciledAt: null });
  for (const change of [
    { ref: "other" }, { deleted_at: instant }, { postgrest_desired: "stopped" },
    { postgrest_actual: "starting" }, { postgrest_health: "unknown" },
    { postgrest_port: "54321" }, { postgrest_port: 54322 }, { postgrest_port: 0 },
    { postgrest_last_error: "wrong error" }, { postgrest_updated_at: null },
    { observation_time_matches: false }, { observation_time_matches: null },
  ]) {
    expect(() => parsePostgrestObservationReceipt({ ...receipt, ...change }, "fixture", expected))
      .toThrow(InvalidPostgrestObservationReceiptError);
  }
});

test("observations require valid state combinations and detached own data", () => {
  for (const observation of [
    { actual: "running", health: "healthy", last_error: null },
    { actual: "stopped", health: "unknown", last_error: null },
    { actual: "starting", health: "unknown", last_error: null },
    { actual: "error", health: "unhealthy", last_error: "probe failed" },
  ]) {
    expect(parsePostgrestObservation(observation)).toEqual(observation);
  }
  for (const observation of invalidObservations) {
    expect(() => parsePostgrestObservation(observation)).toThrow(InvalidPostgrestObservationError);
  }
  let getters = 0;
  const accessor = Object.defineProperty({}, "actual", { get() { getters++; return "running"; } });
  expect(() => parsePostgrestObservation(accessor)).toThrow(InvalidPostgrestObservationError);
  expect(getters).toBe(0);
  const original = { actual: "running", health: "healthy", last_error: null };
  const snapshot = parsePostgrestObservation(original);
  original.health = "unhealthy";
  expect(snapshot.health).toBe("healthy");
});

test("status metadata preserves canonical dates and only falls back for missing timestamps", () => {
  const date = new Date(instant);
  const captured = parsePostgrestStatusRecord({
    ...base, postgrest_updated_at: date, postgrest_last_reconciled_at: instant, postgrest_last_error: "previous error",
  }, "fixture");
  date.setTime(0);
  expect(captured).toEqual({
    desired: "running", revision: "1", updatedAt: instant, lastReconciledAt: instant, lastError: "previous error",
  });
  expect(parsePostgrestStatusRecord({ ...base, postgrest_updated_at: null }, "fixture")).toEqual({
    desired: "running", revision: "1", updatedAt: instant, lastReconciledAt: null, lastError: null,
  });
  expect(parsePostgrestStatusRecord({
    ref: "fixture", postgrest_desired: "stopped", postgrest_row_revision: "1",
  }, "fixture")).toEqual({ desired: "stopped", revision: "1", updatedAt: null, lastReconciledAt: null, lastError: null });
});

test("status metadata rejects foreign, malformed and accessor-backed records", () => {
  const invalid: unknown[] = [
    undefined, null, [], { ...base, ref: "other" }, { ...base, ref: undefined },
    { ...base, postgrest_desired: "unknown" }, { ...base, postgrest_last_error: 1 },
    ...[undefined, null, 1, "", "01", "-1", "4294967296"].map(postgrest_row_revision => ({ ...base, postgrest_row_revision })),
    ...["postgrest_updated_at", "updated_at", "postgrest_last_reconciled_at"].flatMap(field =>
      [false, 0, "", "not-a-date", "2026-02-30T00:00:00.000Z", "2026-09-10", new Date(NaN), {}]
        .map(value => ({ ...base, [field]: value }))),
  ];
  let getters = 0;
  for (const key of ["ref", "postgrest_updated_at", "postgrest_last_error"]) {
    invalid.push(Object.defineProperty({ ...base }, key, {
      get() { getters++; throw new Error("Private fixture details"); },
    }));
  }
  for (const row of invalid) {
    expect(() => parsePostgrestStatusRecord(row, "fixture"))
      .toThrow("Invalid persisted PostgREST status record");
  }
  expect(getters).toBe(0);
});

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native status reads reject missing or invalid projects before controller observation and writes",
  async () => withNativePostgres(async database => {
    const originalDb = { ...await import("../../src/db") };
    mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
    const { tenantRuntimeService } = await import("../../src/services/tenant-runtime.service");
    let resolvedPort: unknown = 54321;
    const port = mock(async () => resolvedPort);
    let observation: unknown = { actual: "running", health: "healthy", last_error: null };
    let onObserve: (() => Promise<void>) | undefined;
    const observe = mock(async () => { await onObserve?.(); return observation; });
    let unitResult: (ref: string) => unknown = ref => `supacloud-pgrst@${ref}`;
    const replacements: Record<string, unknown> = {
      getTenantPort: port,
      postgrestController: { observe, unit: (ref: string) => unitResult(ref) },
    };
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries(replacements)) {
      originals.set(key, Object.getOwnPropertyDescriptor(tenantRuntimeService, key));
      Object.defineProperty(tenantRuntimeService, key, { configurable: true, value });
    }
    try {
      await database.unsafe(`
        CREATE TABLE projects (
          ref text PRIMARY KEY, status text, deleted_at timestamptz,
          postgrest_desired text, postgrest_actual text, postgrest_health text,
          postgrest_port integer, postgrest_last_error text,
          postgrest_updated_at timestamptz, postgrest_last_reconciled_at timestamptz,
          updated_at timestamptz
        );
        INSERT INTO projects(ref, status, postgrest_desired, updated_at, postgrest_last_error) VALUES
          ('fixture', 'active', 'running', '2026-09-10T00:00:00Z', 'stale runtime error'),
          ('invalid', 'active', 'unknown', '2026-09-10T00:00:00Z', NULL),
          ('bad-legacy', 'UNKNOWN', NULL, '2026-09-10T00:00:00Z', NULL);
        INSERT INTO projects(ref, status, postgrest_desired, deleted_at) VALUES
          ('deleted', 'active', 'running', NOW());
      `);
      const before = Array.from(await database`
        SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
      `);
      for (const ref of ["missing", "invalid", "bad-legacy", "deleted"]) {
        await expect(tenantRuntimeService.statusPostgrest(ref)).rejects.toBeInstanceOf(InvalidPostgrestStatusRecordError);
      }
      expect(port).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(Array.from(await database`
        SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
      `)).toEqual(before);

      try {
        for (const target of invalidTargets) {
          resolvedPort = target.port;
          unitResult = () => target.unit;
          await expect(tenantRuntimeService.statusPostgrest("fixture"))
            .rejects.toBeInstanceOf(InvalidPostgrestRuntimeTargetError);
          expect(observe).not.toHaveBeenCalled();
          expect(Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `)).toEqual(before);
        }
      } finally {
        resolvedPort = 54321;
        unitResult = ref => `supacloud-pgrst@${ref}`;
      }
      for (const invalid of invalidObservations) {
        observation = invalid;
        await expect(tenantRuntimeService.statusPostgrest("fixture"))
          .rejects.toBeInstanceOf(InvalidPostgrestObservationError);
        expect(Array.from(await database`
          SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
        `)).toEqual(before);
      }
      expect(observe).toHaveBeenCalledTimes(invalidObservations.length);
      port.mockClear();
      observe.mockClear();
      observation = { actual: "running", health: "healthy", last_error: null };
      const status = await tenantRuntimeService.statusPostgrest("fixture");
      expect(status).toMatchObject({
        desired: "running", actual: "running", health: "healthy",
        port: 54321, unit: validUnit, last_error: null,
      });
      expect(port).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledWith("fixture", 54321);
      expect(Array.from(await database`
        SELECT postgrest_actual, postgrest_health, postgrest_port, postgrest_last_error,
          postgrest_updated_at IS NOT NULL AS observed FROM projects WHERE ref = 'fixture'
      `)).toEqual([{
        postgrest_actual: "running", postgrest_health: "healthy", postgrest_port: 54321,
        postgrest_last_error: null, observed: true,
      }]);
      const storedTimeRows = Array.from(await database`
        SELECT postgrest_updated_at FROM projects WHERE ref = 'fixture'
      `);
      const storedTime: unknown = storedTimeRows[0]?.postgrest_updated_at;
      expect(storedTime).toBeInstanceOf(Date);
      if (!(storedTime instanceof Date)) throw new Error("Expected native timestamp");
      expect(status.updated_at).toBe(storedTime.toISOString());
      observation = { actual: "error", health: "unhealthy", last_error: "current probe failed" };
      expect(await tenantRuntimeService.statusPostgrest("fixture")).toMatchObject({
        actual: "error", health: "unhealthy", last_error: "current probe failed",
      });
      observation = { actual: "stopped", health: "unknown", last_error: null };
      expect(await tenantRuntimeService.statusPostgrest("fixture")).toMatchObject({
        actual: "stopped", health: "unknown", last_error: null,
      });
      expect(Array.from(await database`
        SELECT postgrest_actual, postgrest_last_error FROM projects WHERE ref = 'fixture'
      `)).toEqual([{ postgrest_actual: "stopped", postgrest_last_error: null }]);
      for (const race of ["pause", "delete", "replace", "newer-observation"]) {
        const ref = `race-${race}`;
        await database`
          INSERT INTO projects(ref, status, postgrest_desired, updated_at)
          VALUES (${ref}, 'active', 'running', NOW())
        `;
        let afterConcurrentChange: unknown;
        onObserve = async () => {
          if (race === "pause") {
            await database`
              UPDATE projects SET status = 'paused', postgrest_desired = 'stopped' WHERE ref = ${ref}
            `;
          } else if (race === "delete") {
            await database`UPDATE projects SET deleted_at = NOW() WHERE ref = ${ref}`;
          } else if (race === "replace") {
            await database.begin(async transaction => {
              await transaction`DELETE FROM projects WHERE ref = ${ref}`;
              await transaction`
                INSERT INTO projects(ref, status, postgrest_desired, updated_at)
                VALUES (${ref}, 'paused', 'stopped', NOW())
              `;
            });
          } else {
            await database`
              UPDATE projects SET postgrest_actual = 'error', postgrest_health = 'unhealthy',
                postgrest_last_error = 'newer probe failure' WHERE ref = ${ref}
            `;
          }
          afterConcurrentChange = Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `);
        };
        observation = { actual: "running", health: "healthy", last_error: null };
        observe.mockClear();
        try {
          await expect(tenantRuntimeService.statusPostgrest(ref)).rejects.toBeInstanceOf(PostgrestObservationConflictError);
          expect(observe).toHaveBeenCalledTimes(1);
          expect(Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `)).toEqual(afterConcurrentChange);
        } finally {
          onObserve = undefined;
        }
      }
      await database`
        INSERT INTO projects(ref, status, postgrest_desired, updated_at)
        VALUES ('concurrent-observers', 'active', 'running', NOW())
      `;
      let entrants = 0;
      let releaseObservers = () => {};
      const bothObserving = new Promise<void>(resolve => { releaseObservers = resolve; });
      const releaseDeadline = setTimeout(releaseObservers, 2000);
      onObserve = async () => {
        entrants++;
        if (entrants === 2) releaseObservers();
        await bothObserving;
      };
      observe.mockClear();
      try {
        const outcomes = await Promise.allSettled([
          tenantRuntimeService.statusPostgrest("concurrent-observers"),
          tenantRuntimeService.statusPostgrest("concurrent-observers"),
        ]);
        expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
        const failures = outcomes.filter(result => result.status === "rejected");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.reason).toBeInstanceOf(PostgrestObservationConflictError);
        expect(observe).toHaveBeenCalledTimes(2);
        expect(Array.from(await database`
          SELECT postgrest_actual, postgrest_health, postgrest_port FROM projects
          WHERE ref = 'concurrent-observers'
        `)).toEqual([{ postgrest_actual: "running", postgrest_health: "healthy", postgrest_port: 54321 }]);
      } finally {
        clearTimeout(releaseDeadline);
        releaseObservers();
        onObserve = undefined;
      }
      await database.unsafe(`
        CREATE SEQUENCE observation_write_attempts;
        CREATE FUNCTION corrupt_observation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.ref NOT LIKE 'receipt-fault-%' THEN RETURN NEW; END IF;
          PERFORM nextval('observation_write_attempts');
          CASE substring(OLD.ref from '^receipt-fault-(.*)$')
            WHEN 'ref' THEN NEW.ref := 'moved-' || OLD.ref;
            WHEN 'deleted' THEN NEW.deleted_at := NOW();
            WHEN 'desired' THEN NEW.postgrest_desired := 'stopped';
            WHEN 'actual' THEN NEW.postgrest_actual := 'error';
            WHEN 'health' THEN NEW.postgrest_health := 'unknown';
            WHEN 'port' THEN NEW.postgrest_port := 54322;
            WHEN 'error' THEN NEW.postgrest_last_error := 'wrong error';
            WHEN 'timestamp-null' THEN NEW.postgrest_updated_at := NULL;
            WHEN 'timestamp-old' THEN
              NEW.postgrest_updated_at := '2000-01-01T00:00:00Z';
              NEW.updated_at := NEW.postgrest_updated_at;
            ELSE RAISE EXCEPTION 'Unknown observation fixture fault';
          END CASE;
          RETURN NEW;
        END $$;
        CREATE TRIGGER observation_receipt_fault BEFORE UPDATE OF postgrest_actual ON projects
          FOR EACH ROW EXECUTE FUNCTION corrupt_observation_receipt();
      `);
      let attempts = 0;
      try {
        for (const fault of ["ref", "deleted", "desired", "actual", "health", "port", "error", "timestamp-null", "timestamp-old"]) {
          const ref = `receipt-fault-${fault}`;
          await database`
            INSERT INTO projects(ref, status, postgrest_desired, updated_at)
            VALUES (${ref}, 'active', 'running', NOW())
          `;
          const beforeFault = Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `);
          observe.mockClear();
          await expect(tenantRuntimeService.statusPostgrest(ref)).rejects.toBeInstanceOf(InvalidPostgrestObservationReceiptError);
          expect(observe).toHaveBeenCalledTimes(1);
          expect(Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `)).toEqual(beforeFault);
          expect(Array.from(await database`
            SELECT last_value::integer AS count FROM observation_write_attempts
          `)).toEqual([{ count: ++attempts }]);
        }
      } finally {
        await database.unsafe("DROP TRIGGER observation_receipt_fault ON projects");
      }
      await database.unsafe(`
        CREATE FUNCTION corrupt_observation_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.ref = 'deferred-valid' THEN
            PERFORM nextval('observation_write_attempts');
            RETURN NEW;
          END IF;
          IF NEW.ref NOT LIKE 'after-fault-%' OR pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
          PERFORM nextval('observation_write_attempts');
          CASE NEW.ref
            WHEN 'after-fault-port' THEN
              UPDATE projects SET postgrest_port = 54322 WHERE ref = NEW.ref;
            WHEN 'after-fault-ref' THEN
              UPDATE projects SET ref = 'moved-' || NEW.ref WHERE ref = NEW.ref;
            WHEN 'after-fault-delete' THEN
              DELETE FROM projects WHERE ref = NEW.ref;
            WHEN 'after-fault-timestamp' THEN
              UPDATE projects SET postgrest_updated_at = '2000-01-01T00:00:00Z' WHERE ref = NEW.ref;
            WHEN 'after-fault-reconciled' THEN
              UPDATE projects SET postgrest_last_reconciled_at = NOW() WHERE ref = NEW.ref;
            ELSE RAISE EXCEPTION 'Unknown after-write fixture fault';
          END CASE;
          RETURN NEW;
        END $$;
        CREATE TRIGGER observation_after_fault AFTER UPDATE ON projects
          FOR EACH ROW EXECUTE FUNCTION corrupt_observation_after_write();
      `);
      try {
        for (const fault of ["port", "ref", "delete", "timestamp", "reconciled"]) {
          const ref = `after-fault-${fault}`;
          await database`
            INSERT INTO projects(ref, status, postgrest_desired, updated_at)
            VALUES (${ref}, 'active', 'running', NOW())
          `;
          const beforeFault = Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `);
          observe.mockClear();
          await expect(tenantRuntimeService.statusPostgrest(ref)).rejects.toBeInstanceOf(InvalidPostgrestObservationReceiptError);
          expect(observe).toHaveBeenCalledTimes(1);
          expect(Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `)).toEqual(beforeFault);
          expect(Array.from(await database`
            SELECT last_value::integer AS count FROM observation_write_attempts
          `)).toEqual([{ count: ++attempts }]);
        }
      } finally {
        await database.unsafe("DROP TRIGGER observation_after_fault ON projects");
      }
      await database.unsafe(`
        CREATE CONSTRAINT TRIGGER observation_deferred_fault AFTER UPDATE ON projects
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          WHEN (OLD.postgrest_actual IS DISTINCT FROM NEW.postgrest_actual)
          EXECUTE FUNCTION corrupt_observation_after_write();
      `);
      try {
        await database`
          INSERT INTO projects(ref, status, postgrest_desired, updated_at)
          VALUES ('deferred-valid', 'active', 'running', NOW())
        `;
        const validDeferred = await tenantRuntimeService.statusPostgrest("deferred-valid");
        expect(validDeferred.actual).toBe("running");
        expect(validDeferred.health).toBe("healthy");
        expect(Array.from(await database`
          SELECT postgrest_actual, postgrest_health, postgrest_port
          FROM projects WHERE ref = 'deferred-valid'
        `)).toEqual([{ postgrest_actual: "running", postgrest_health: "healthy", postgrest_port: 54321 }]);
        expect(Array.from(await database`
          SELECT last_value::integer AS count FROM observation_write_attempts
        `)).toEqual([{ count: ++attempts }]);
        for (const fault of ["port", "ref", "delete", "timestamp", "reconciled"]) {
          const ref = `after-fault-${fault}`;
          const beforeFault = Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `);
          observe.mockClear();
          await expect(tenantRuntimeService.statusPostgrest(ref)).rejects.toBeInstanceOf(InvalidPostgrestObservationReceiptError);
          expect(observe).toHaveBeenCalledTimes(1);
          expect(Array.from(await database`
            SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY ref)) AS hash FROM projects p
          `)).toEqual(beforeFault);
          expect(Array.from(await database`
            SELECT last_value::integer AS count FROM observation_write_attempts
          `)).toEqual([{ count: ++attempts }]);
        }
      } finally {
        await database.unsafe("DROP TRIGGER observation_deferred_fault ON projects");
      }
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(tenantRuntimeService, key, descriptor);
        else Reflect.deleteProperty(tenantRuntimeService, key);
      }
      mock.module("../../src/db", () => originalDb);
    }
  }), 30_000,
);
