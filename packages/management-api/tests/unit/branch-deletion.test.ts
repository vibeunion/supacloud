import { expect, spyOn, test } from "bun:test";
import { branchService } from "../../src/services/branch.service";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";
import { projectRepository } from "../../src/repositories/project.repository";
import { sql } from "../../src/db";

test.each(["stop", "drop", "readback", "retained"] as const)(
  "deleteBranch preserves project identity when %s cannot confirm deletion",
  async failure => {
    const service = branchService as unknown as { databaseExists(name: string): Promise<boolean> };
    const stopped = spyOn(tenantRuntimeService, "stopRuntime").mockImplementation(async () => {
      if (failure === "stop") throw new Error("stop unavailable");
    });
    const dropped = spyOn(sql, "unsafe").mockImplementation(() => {
      if (failure === "drop") throw new Error("drop unavailable");
      return [] as never;
    });
    const readback = spyOn(service, "databaseExists").mockImplementation(async () => {
      if (failure === "readback") throw new Error("catalog unavailable");
      return failure === "retained";
    });
    const softDelete = spyOn(projectRepository, "softDelete").mockResolvedValue(null);
    try {
      await expect(branchService.deleteBranch("pv0123456789ab4def81")).rejects.toThrow();
      expect(softDelete).not.toHaveBeenCalled();
      if (failure === "stop") expect(dropped).not.toHaveBeenCalled();
      if (failure === "stop" || failure === "drop") expect(readback).not.toHaveBeenCalled();
    } finally {
      stopped.mockRestore();
      dropped.mockRestore();
      readback.mockRestore();
      softDelete.mockRestore();
    }
  },
);

test("deleteBranch verifies database absence before soft deleting and propagates receipt failures", async () => {
  const calls: string[] = [];
  const service = branchService as unknown as { databaseExists(name: string): Promise<boolean> };
  const stopped = spyOn(tenantRuntimeService, "stopRuntime").mockImplementation(async ref => { calls.push(`stop:${ref}`); });
  const dropped = spyOn(sql, "unsafe").mockImplementation(statement => {
    calls.push(String(statement));
    return [] as never;
  });
  const readback = spyOn(service, "databaseExists").mockImplementation(async name => { calls.push(`verify:${name}`); return false; });
  const softDelete = spyOn(projectRepository, "softDelete").mockImplementation(async ref => {
    calls.push(`deleted:${ref}`);
    return { ref, status: "deleted", deleted_at: new Date() } as never;
  });
  try {
    await branchService.deleteBranch("pv0123456789ab4def81");
    expect(calls).toEqual([
      "stop:pv0123456789ab4def81", 'DROP DATABASE IF EXISTS "supa_pv0123456789ab4def81"',
      "verify:supa_pv0123456789ab4def81", "deleted:pv0123456789ab4def81",
    ]);
    softDelete.mockRejectedValueOnce(new Error("receipt unavailable"));
    await expect(branchService.deleteBranch("pv0123456789ab4def81")).rejects.toThrow("receipt unavailable");
    softDelete.mockResolvedValueOnce(null);
    await expect(branchService.deleteBranch("pv0123456789ab4def81")).rejects.toThrow("BRANCH_PROJECT_DELETION_UNCONFIRMED");
  } finally {
    stopped.mockRestore();
    dropped.mockRestore();
    readback.mockRestore();
    softDelete.mockRestore();
  }
});
