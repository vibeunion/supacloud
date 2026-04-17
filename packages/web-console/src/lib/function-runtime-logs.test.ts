import { describe, expect, test } from "bun:test";
import {
  filterFunctionRuntimeLogs,
  getFunctionRuntimeErrorLogs,
  getFunctionRuntimeLogClass,
  getFunctionRuntimeSeveritySummary,
  getRecentFunctionRuntimeLogs,
  hasFunctionRuntimeWarnings,
  type FunctionRuntimeLogRecord,
} from "./function-runtime-logs";

const logs: FunctionRuntimeLogRecord[] = [
  {
    id: "1",
    timestamp: "2026-04-17T12:00:00.000Z",
    event_type: "log",
    severity: "info",
    message: "started",
    metadata: {},
  },
  {
    id: "2",
    timestamp: "2026-04-17T12:00:01.000Z",
    event_type: "log",
    severity: "warn",
    message: "slow downstream",
    metadata: {},
  },
  {
    id: "3",
    timestamp: "2026-04-17T12:00:02.000Z",
    event_type: "log",
    severity: "error",
    message: "boom",
    metadata: {},
  },
  {
    id: "4",
    timestamp: "2026-04-17T12:00:03.000Z",
    event_type: "log",
    severity: "fatal",
    message: "crash",
    metadata: {},
  },
];

describe("function runtime log helpers", () => {
  test("returns recent runtime logs", () => {
    expect(getRecentFunctionRuntimeLogs(logs, 2)).toEqual(logs.slice(0, 2));
  });

  test("returns only error-like runtime logs", () => {
    expect(getFunctionRuntimeErrorLogs(logs, 2)).toEqual(logs.slice(2, 4));
  });

  test("filters runtime logs by severity and search", () => {
    expect(
      filterFunctionRuntimeLogs(logs, { severity: "warning" }).map(
        (log) => log.id,
      ),
    ).toEqual(["2"]);
    expect(
      filterFunctionRuntimeLogs(logs, { severity: "info", search: "start" }).map(
        (log) => log.id,
      ),
    ).toEqual(["1"]);
  });

  test("detects warning logs", () => {
    expect(hasFunctionRuntimeWarnings(logs)).toBe(true);
  });

  test("summarizes runtime severities", () => {
    expect(getFunctionRuntimeSeveritySummary(logs)).toEqual({
      errors: 2,
      warnings: 1,
      info: 1,
    });
  });

  test("maps log severity to UI classes", () => {
    expect(getFunctionRuntimeLogClass(logs[0])).toContain("blue");
    expect(getFunctionRuntimeLogClass(logs[1])).toContain("amber");
    expect(getFunctionRuntimeLogClass(logs[2])).toContain("red");
  });
});
