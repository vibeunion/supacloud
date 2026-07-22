import { describe, expect, test } from "bun:test";
import { toPhysicalBackupViewModel, type PhysicalBackupRecord } from "./physical-backup";

describe("physical backup view model", () => {
  test("maps the management API wire record into renderable backup history fields", () => {
    const backup: PhysicalBackupRecord = {
      id: "20260722-120000F",
      type: "full",
      timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
      size: 2048,
      database: "supa_project_a",
    };

    expect(toPhysicalBackupViewModel(backup)).toEqual({
      id: "20260722-120000F",
      type: "full",
      status: "completed",
      timestamp: "2026-07-14T03:33:50.000Z",
      size: "2 KB",
      label: "20260722-120000F",
    });
  });

  test("uses the start timestamp and running state for an unfinished record", () => {
    expect(toPhysicalBackupViewModel({
      id: "20260722-120000I",
      type: "incr",
      timestamp: { start: 1_784_000_000, stop: 0 },
      size: 512,
    })).toMatchObject({
      status: "in_progress",
      timestamp: "2026-07-14T03:33:20.000Z",
      size: "512 B",
    });
  });
});
