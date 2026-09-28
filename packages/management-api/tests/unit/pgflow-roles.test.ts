import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPgflowRoleBundle } from "../../scripts/bundle-pgflow-roles";
import { renderRoles, renderQueueGrants, roleNames } from "../../src/services/pgflow-roles";
import {
  renderRoles as workerRoles,
  renderQueueGrants as workerQueueGrants,
} from "../../../worker/scripts/roles";
import { roleNames as workerRoleNames } from "../../../worker/scripts/scheduler";

test("embedded pgflow role SQL is generated from the canonical Worker source", () => {
  expect(readFileSync(new URL("../../src/db/pgflow-role-bundle.ts", import.meta.url), "utf8"))
    .toBe(renderPgflowRoleBundle());
});

test.each(["a", "project-one", "supacloud-template", "a".repeat(100)])(
  "embedded role and control SQL preserves canonical output for %s",
  (projectRef) => {
    expect(renderRoles(projectRef)).toBe(workerRoles(projectRef));
    expect(renderQueueGrants(projectRef)).toBe(workerQueueGrants(projectRef));
    const { owner, worker, recovery } = workerRoleNames(projectRef);
    expect(roleNames(projectRef)).toEqual({ owner, worker, recovery });
    expect(renderRoles(projectRef)).not.toContain("__SCW_");
  },
);

test.each(["", "-project", "Project", "project';--", "a".repeat(101)])(
  "both role renderers reject invalid project refs: %s",
  (projectRef) => {
    expect(() => renderRoles(projectRef)).toThrow("PGFLOW_PROJECT_INVALID");
    expect(() => renderQueueGrants(projectRef)).toThrow("PGFLOW_PROJECT_INVALID");
    expect(() => workerRoles(projectRef)).toThrow("PGFLOW_PROJECT_INVALID");
  },
);

test("bundled role renderer runs without the Worker source tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgflow-role-bundle-"));
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../../src/services/pgflow-roles.ts", import.meta.url))],
      target: "bun",
      outdir: directory,
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn([
      process.execPath, "--no-env-file", "-e",
      'import { renderRoles } from "./pgflow-roles.js"; console.log(renderRoles("project-one"));',
    ], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trimEnd()).toBe(workerRoles("project-one").trimEnd());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
