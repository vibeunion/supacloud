import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/services/user-safety.service.ts", import.meta.url),
  "utf8",
);

describe("GoTrue user deletion task safety", () => {
  test("checks active tasks inside the locked deletion transaction", () => {
    expect(source).toContain("taskRepository.countActiveTasksByInvoker(");
    expect(source).toContain("projectRef,\n    userId,\n    transaction");
    expect(source).not.toContain("export async function checkUserActiveTasks");
  });

  test("requires an active operation lease and renews it before GoTrue DELETE", () => {
    const markSource = source.slice(
      source.indexOf("export async function markUserDeletionStarted"),
      source.indexOf("export async function completeUserDeletion"),
    );

    expect(markSource).toContain("operation_expires_at > NOW()");
    expect(markSource).toContain("operation_expires_at = NOW() + INTERVAL '5 minutes'");
  });
});
