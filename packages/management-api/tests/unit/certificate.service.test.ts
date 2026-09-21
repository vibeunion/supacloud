// @supacloud-test-isolate
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../src/config";
import type { Project } from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { CertificateService } from "../../src/services/certificate.service";
import { gatewayService } from "../../src/services/gateway.service";
import { taskProjectFixture } from "../helpers/task-fixtures";

const previousConfig = {
  acmeStateDir: config.acmeStateDir,
  acmeHttpWebroot: config.acmeHttpWebroot,
  legoBin: config.legoBin,
};
let root: string;
let project: Project;
const findProject = spyOn(projectRepository, "findByRef");
const updateConfig = spyOn(projectRepository, "updateConfig");
const deploy = spyOn(gatewayService, "upsertCertificateForSnis");
const service = new CertificateService();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "supacloud-certificate-"));
  config.acmeStateDir = join(root, "acme");
  config.acmeHttpWebroot = join(root, "webroot");
  config.legoBin = join(root, "lego-fixture");
  await writeFile(config.legoBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  project = taskProjectFixture({
    ref: "certificate-project",
    config: {
      certificate: {
        mode: "lego", challenge: "http-01", email: "test@example.test",
        domains: ["certificate.example.test"], auto_renew: false,
        status: "error", last_error: "previous failure",
      },
    },
  });
  findProject.mockReset();
  findProject.mockImplementation(async (ref) => ref === project.ref ? structuredClone(project) : null);
  updateConfig.mockReset();
  updateConfig.mockImplementation(async (ref, settings) => {
    if (ref !== project.ref) return null;
    project = { ...project, config: structuredClone(settings) };
    return structuredClone(project);
  });
  deploy.mockReset();
  deploy.mockResolvedValue({ success: true, certificateId: "certificate-id" });
});

afterEach(async () => {
  Object.assign(config, previousConfig);
  await rm(root, { recursive: true, force: true });
});

afterAll(() => {
  findProject.mockRestore();
  updateConfig.mockRestore();
  deploy.mockRestore();
});

describe("CertificateService typed state transitions", () => {
  test("omits unset metadata and preserves false and empty settings", async () => {
    project.config.certificate = { email: "", auto_renew: false, domains: ["certificate.example.test"] };
    const settings = await service.getSettings(project.ref);
    expect(settings).toMatchObject({ email: "", auto_renew: false });
    expect(settings).not.toHaveProperty("certificate_id");
    expect(settings).not.toHaveProperty("issued_at");
    expect(settings).not.toHaveProperty("last_error");
  });

  test("clears a previous error only on successful persisted deployment", async () => {
    const result = await service.deployCertificate(project.ref, { cert: "fixture-cert", key: "fixture-key" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.settings).toMatchObject({ status: "deployed", certificate_id: "certificate-id", auto_renew: false });
    expect(result.settings).not.toHaveProperty("last_error");
    expect(project.config.certificate).not.toHaveProperty("last_error");
    expect(deploy.mock.lastCall?.[0]).not.toHaveProperty("existingCertificateId");
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  test("does not clear errors when an unrelated setting changes", async () => {
    const settings = await service.updateSettings(project.ref, { auto_renew: true });
    expect(settings).toMatchObject({ auto_renew: true, last_error: "previous failure" });
    const cleared = await service.updateSettings(project.ref, { last_error: null });
    expect(cleared).not.toHaveProperty("last_error");
    expect(project.config.certificate).not.toHaveProperty("last_error");
  });

  test("does not claim success when a deployed certificate's settings update returns no row", async () => {
    updateConfig.mockResolvedValueOnce(null);
    await expect(service.deployCertificate(project.ref, { cert: "fixture-cert", key: "fixture-key" }))
      .resolves.toEqual({ success: false, error: "Certificate deployed but project settings could not be persisted" });
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  test("preserves an existing certificate id and records a failed gateway deployment", async () => {
    project.config.certificate = {
      certificate_id: "existing-id", domains: ["certificate.example.test"],
    };
    deploy.mockResolvedValueOnce({ success: false, error: "gateway unavailable" });
    await expect(service.deployCertificate(project.ref, { cert: "fixture-cert", key: "fixture-key" }))
      .resolves.toEqual({ success: false, error: "gateway unavailable" });
    expect(deploy.mock.lastCall?.[0].existingCertificateId).toBe("existing-id");
    expect(project.config.certificate).toMatchObject({ status: "error", last_error: "gateway unavailable" });
  });

  test("does not start a deployment for a missing project or failed initial persistence", async () => {
    await expect(service.deployCertificate("missing", { cert: "fixture-cert", key: "fixture-key" }))
      .resolves.toEqual({ success: false, error: "Project not found" });
    updateConfig.mockResolvedValueOnce(null);
    await expect(service.issueWithLego(project.ref, {}))
      .resolves.toEqual({ success: false, error: "Project not found" });
    expect(deploy).not.toHaveBeenCalled();
  });

  test("does not deploy another domain's certificate when the expected output is missing", async () => {
    const certificateDir = join(config.acmeStateDir, "certificates");
    await mkdir(certificateDir, { recursive: true });
    await writeFile(join(certificateDir, "other.example.test.crt"), "other-cert");
    await writeFile(join(certificateDir, "other.example.test.key"), "other-key");
    const result = await service.issueWithLego(project.ref, {});
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Unexpected certificate deployment");
    expect(result.error).toContain("certificate.example.test not found");
    expect(deploy).not.toHaveBeenCalled();
    expect(project.config.certificate).toMatchObject({ status: "error" });
  });

  test("persists the issued mode and settings only after deploying the matching output", async () => {
    const certificateDir = join(config.acmeStateDir, "certificates");
    await mkdir(certificateDir, { recursive: true });
    await writeFile(join(certificateDir, "certificate.example.test.crt"), "fixture-cert");
    await writeFile(join(certificateDir, "certificate.example.test.key"), "fixture-key");
    const result = await service.issueWithLego(project.ref, {});
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.settings).toMatchObject({
      mode: "lego", challenge: "http-01", email: "test@example.test", auto_renew: false,
      status: "deployed", certificate_id: "certificate-id",
    });
    expect(result.settings).not.toHaveProperty("last_error");
    expect(deploy.mock.lastCall?.[0]).toMatchObject({
      cert: "fixture-cert", key: "fixture-key", snis: ["certificate.example.test"],
    });
  });
});
