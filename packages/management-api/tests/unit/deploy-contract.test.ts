import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InvalidDeploymentRecordError, isDeployVersion, readDeployConfig, readDeploymentRows,
  readDeployRequest, readPreviousDeployVersion, type DeployConfig,
} from "../../src/utils/deploy-contract";

const config: DeployConfig = {
  app: "fixture", tenant: "fixture-tenant",
  static: [{ name: "site", source: "dist", target: "/tmp/fixture/site" }],
};
const row = {
  id: "fixture-deploy", app: config.app, tenant: config.tenant, version: "20260909_120000",
  status: "success", deployed_at: new Date("2026-09-09T12:00:00Z"), triggered_by: "fixture", config,
};
const request = { app: config.app, tenant: config.tenant, artifact: "YQ==", config };

test.each(["20240229_235959", "20260909_000000", `20260909_120000_${crypto.randomUUID()}`])(
  "accepts generated or legacy deployment version %s", version => { expect(isDeployVersion(version)).toBe(true); },
);
test.each(["20230229_000000", "20261301_000000", "20260909_240000", "20260909_126000", "20260909_120000\n",
  "20260909_120000_extra", "../target", "", "20260909_120000/other"])(
  "rejects invalid version %s", version => { expect(isDeployVersion(version)).toBe(false); },
);
test.each([null, [], {}, { ...config, static: [] }, { ...config, static: [null] }, { ...config, static: new Array(1) }]
  .map(value => ({ value })))("rejects invalid deployment config %#", ({ value }) => {
    expect(() => readDeployConfig(value)).toThrow(InvalidDeploymentRecordError);
  });
test.each(["../outside", "dist/../outside", "/absolute", "./dist", "dist//nested"])(
  "rejects unsafe artifact source %s", source => {
    expect(() => readDeployConfig({ ...config, static: [{ name: "site", source, target: "/tmp/fixture/site" }] }))
      .toThrow(InvalidDeploymentRecordError);
  },
);
test.each(["relative", "/", "/tmp/../outside", "/tmp//site"])("rejects ambiguous target %s", target => {
  expect(() => readDeployConfig({ ...config, static: [{ name: "site", source: "dist", target }] })).toThrow(InvalidDeploymentRecordError);
});
test.each(["", "YQ", "YQ==\n", "YQ===", "!!!!", "YR=="])("rejects noncanonical artifact %s", artifact => {
  expect(() => readDeployRequest({ ...request, artifact })).toThrow(InvalidDeploymentRecordError);
});
test("deployment input binds config identity and takes a known-field snapshot", () => {
  expect(() => readDeployRequest({ ...request, tenant: "other" })).toThrow(InvalidDeploymentRecordError);
  const input = { ...request, config: {
    ...config, static: [{ name: "site", source: "dist", target: "/tmp/fixture/site" }],
    hooks: { pre_deploy: "echo ready" }, unknown_secret: "private",
  } };
  const snapshot = readDeployRequest(input);
  input.config.static.splice(0, 1);
  input.config.hooks.pre_deploy = "changed";
  expect(snapshot.config.static).toEqual([{ name: "site", source: "dist", target: "/tmp/fixture/site" }]);
  expect(snapshot.config.hooks).toEqual({ pre_deploy: "echo ready" });
  expect(snapshot.config).not.toHaveProperty("unknown_secret");
});
test("retention, service names, env values and duplicate targets cannot hide bad input", () => {
  expect(() => readDeployConfig({ ...config, retention: { keep_versions: 0 } })).toThrow(InvalidDeploymentRecordError);
  expect(() => readDeployConfig({ ...config, retention: { auto_cleanup: "false" } })).toThrow(InvalidDeploymentRecordError);
  expect(() => readDeployConfig({ ...config, static: [...(config.static ?? []), ...(config.static ?? [])] }))
    .toThrow(InvalidDeploymentRecordError);
  for (const patch of [{ service: "--help" }, { env: { TOKEN: "a\nB=b" } }, { env: { TOKEN: 1 } }]) {
    expect(() => readDeployConfig({ ...config, static: [], ssr: [{
      name: "ssr", source: "dist", target: "/tmp/fixture/ssr", service: "fixture.service", ...patch,
    }] })).toThrow(InvalidDeploymentRecordError);
  }
});
test.each([
  { version: "../outside" }, { status: "finished" }, { deployed_at: new Date("invalid") },
  { deployed_at: "2026-09-09" }, { app: "other" }, { tenant: "other" },
  { config: null }, { config: "{" }, { version: "" },
])("rejects invalid deployment row %#", patch => {
  expect(() => readDeploymentRows([{ ...row, ...patch }], { app: config.app })).toThrow(InvalidDeploymentRecordError);
});
test("legacy JSON configs decode once and unknown database columns stay private", () => {
  const decoded = readDeploymentRows([{ ...row, config: JSON.stringify(config), future_secret: "private" }], { app: config.app });
  expect(decoded[0]?.config).toEqual(config);
  expect(decoded[0]?.deployedAt).toEqual(row.deployed_at);
  expect(decoded[0]?.deployedAt).not.toBe(row.deployed_at);
  expect(decoded[0]).not.toHaveProperty("future_secret");
  expect(() => readDeploymentRows([row, row])).toThrow(InvalidDeploymentRecordError);
  expect(() => readDeploymentRows(new Array(1))).toThrow(InvalidDeploymentRecordError);
  expect(() => readDeploymentRows([row], { version: "20260908_000000" })).toThrow(InvalidDeploymentRecordError);
  expect(readDeploymentRows([{ ...row, status: "failed", version: "" }])[0]?.status).toBe("failed");
});

test("previous version follows a literal sibling directory, not a regular expression or fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-deploy-pointer-"));
  const target = join(directory, "site.[1]+");
  const version = "20260909_120000";
  try {
    expect(await readPreviousDeployVersion(target)).toBeNull();
    const previous = `site.[1]+_${version}`;
    await mkdir(join(directory, previous));
    await symlink(previous, target);
    expect(await readPreviousDeployVersion(target)).toBe(version);
    await unlink(target);
    await mkdir(join(directory, `siteX1_${version}`));
    await symlink(`siteX1_${version}`, target);
    await expect(readPreviousDeployVersion(target)).rejects.toThrow(InvalidDeploymentRecordError);
    await unlink(target);
    await symlink(join(directory, "other", previous), target);
    await expect(readPreviousDeployVersion(target)).rejects.toThrow(InvalidDeploymentRecordError);
    await unlink(target);
    await symlink(`site.[1]+_20260908_120000`, target);
    await expect(readPreviousDeployVersion(target)).rejects.toThrow();
    await unlink(target);
    await Bun.write(target, "not a symlink");
    await expect(readPreviousDeployVersion(target)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
