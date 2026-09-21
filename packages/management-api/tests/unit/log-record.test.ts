import { expect, test } from "bun:test";
import { logSeverity, logTimestamp, parseJournalLogRecord, redactLogMessage, redactLogMetadata } from "../../src/utils/log-record";

const entry = {
  __CURSOR: "s=cursor-1", __REALTIME_TIMESTAMP: "1785200523000001",
  _SYSTEMD_UNIT: "supacloud.service", MESSAGE: "message", PRIORITY: "6",
};

test("journal decoding validates unknown fields and timestamp range without coercion", () => {
  for (const patch of [{ __CURSOR: [] }, { __CURSOR: "" }, { __CURSOR: "x\n" },
    { __REALTIME_TIMESTAMP: true }, { __REALTIME_TIMESTAMP: "1e6" },
    { __REALTIME_TIMESTAMP: "18446744073709551616" }, { __REALTIME_TIMESTAMP: "-1" },
    { _SYSTEMD_UNIT: [] }, { MESSAGE: {} }, { MESSAGE: ["repeated"] }, { MESSAGE: [256] },
    { MESSAGE: [0xff] }, { MESSAGE: new Array(1) }]) {
    expect(parseJournalLogRecord({ ...entry, ...patch })).toBeNull();
  }
  for (const value of [null, [], 1, "message"]) expect(parseJournalLogRecord(value)).toBeNull();
  expect(parseJournalLogRecord({ ...entry, __REALTIME_TIMESTAMP: "0" })?.timestamp).toBe("1970-01-01T00:00:00.000Z");
  expect(parseJournalLogRecord(entry)?.micros).toBe(1785200523000001n);
});

test("valid binary journal messages are decoded and redacted before forwarding", () => {
  const bytes = [...new TextEncoder().encode("Authorization: Bearer synthetic")];
  expect(parseJournalLogRecord({ ...entry, MESSAGE: bytes })?.message).toBe("Authorization=[REDACTED]");
  expect(redactLogMessage("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue")).toBe("[REDACTED]");
});

test("severity honors supported levels without treating null, arrays or booleans as numeric priorities", () => {
  for (const value of [null, undefined, false, true, [], {}, -1, 0.5, 8, "3junk"]) {
    expect(logSeverity(value, "normal request")).toBe("info");
  }
  expect(logSeverity("3", "normal request")).toBe("error");
  expect(logSeverity("7", "normal request")).toBe("debug");
  expect(logSeverity("warning", "normal request")).toBe("warning");
  expect(logSeverity("info", "error count: 0")).toBe("info");
  expect(logSeverity(undefined, "fatal failure")).toBe("error");
});

test("invalid timestamps do not throw or fabricate a current-time value", () => {
  for (const value of [null, {}, false, Infinity, NaN, 9e15, "not-a-date"]) expect(logTimestamp(value)).toBeNull();
  expect(logTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
});

test("metadata validation rejects non-JSON values and cycles with bounded recursion", () => {
  const cycle: Record<string, unknown> = {};
  cycle.next = cycle;
  expect(() => redactLogMetadata(cycle)).toThrow("nesting limit");
  for (const value of [undefined, () => {}, Infinity, new Array(1)]) {
    expect(() => redactLogMetadata(value)).toThrow();
  }
  expect(redactLogMetadata({ nested: { access_token: "hidden", ok: false }, n: 0, empty: null }))
    .toEqual({ nested: { access_token: "[REDACTED]", ok: false }, n: 0, empty: null });
});
