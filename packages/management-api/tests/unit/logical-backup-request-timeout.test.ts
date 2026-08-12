import { describe, expect, mock, test } from "bun:test";
import {
  disableLogicalBackupMutationIdleTimeout,
  withLogicalBackupMutationTimeoutController,
} from "../../src/utils/logical-backup-request-timeout";

function request(path: string, method = "POST"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("logical backup request timeout", () => {
  test.each([
    "/v1/projects/project_a/database/backups/logical",
    "/v1/projects/project_a/database/backups/logical/",
    "/v1/projects/project-a/database/backups/logical/restore",
    "/v1/projects/project-a/database/backups/logical/restore/",
    "/v1/projects/project%5Fa/database/backups/logical",
    "/v1/projects/project%2Da/database/backups/logical/restore",
    "/v1/projects/project_a/database/backups/logical?source=admin",
  ])("disables the active-handler idle timeout for %s", async (path) => {
    const timeout = mock(() => undefined);
    const mutationRequest = request(path);

    await withLogicalBackupMutationTimeoutController(
      mutationRequest,
      { timeout },
      () => disableLogicalBackupMutationIdleTimeout(mutationRequest),
    );

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(mutationRequest, 0);
  });

  test.each([
    ["GET", "/v1/projects/project_a/database/backups/logical"],
    ["GET", "/v1/projects/project_a/database/backups/logical/restore"],
    ["PUT", "/v1/projects/project_a/database/backups/logical"],
    ["POST", "/v1/projects/project_a/database/backups"],
    ["POST", "/v1/projects/project_a/database/backups/restore"],
    ["POST", "/v1/projects/project_a/database/backups/logical/create"],
    ["POST", "/v1/projects/project_a/database/backups/logical/restore/extra"],
    ["POST", "/v1/projects/project.a/database/backups/logical"],
    ["POST", "/v1/projects/project%2Fa/database/backups/logical"],
    ["POST", "/v1/projects/project%ZZ/database/backups/logical"],
    ["POST", "/v1/platform/backups/logical"],
  ])("keeps the global timeout for %s %s", async (method, path) => {
    const timeout = mock(() => undefined);
    const ordinaryRequest = request(path, method);

    await withLogicalBackupMutationTimeoutController(
      ordinaryRequest,
      { timeout },
      () => disableLogicalBackupMutationIdleTimeout(ordinaryRequest),
    );

    expect(timeout).not.toHaveBeenCalled();
  });

  test("retains the binding through async work and removes it after completion", async () => {
    const timeout = mock(() => undefined);
    const mutationRequest = request("/v1/projects/project_a/database/backups/logical");

    await withLogicalBackupMutationTimeoutController(mutationRequest, { timeout }, async () => {
      await Promise.resolve();
      disableLogicalBackupMutationIdleTimeout(mutationRequest);
    });
    disableLogicalBackupMutationIdleTimeout(mutationRequest);

    expect(timeout).toHaveBeenCalledTimes(1);
  });

  test("removes the binding when request handling fails", async () => {
    const timeout = mock(() => undefined);
    const mutationRequest = request("/v1/projects/project_a/database/backups/logical/restore");

    await expect(withLogicalBackupMutationTimeoutController(
      mutationRequest,
      { timeout },
      () => Promise.reject(new Error("route failed")),
    )).rejects.toThrow("route failed");
    disableLogicalBackupMutationIdleTimeout(mutationRequest);

    expect(timeout).not.toHaveBeenCalled();
  });
});
