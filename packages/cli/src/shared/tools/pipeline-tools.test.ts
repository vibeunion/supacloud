import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPipeline } from "./pipeline-tools";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("pipeline connect detects build settings and writes a secret-free GitHub workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-pipeline-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "bun run build" } }));
    await writeFile(join(root, "supacloud.json"), JSON.stringify({ frontend: { outputDirectory: "dist" } }));
    const result = await connectPipeline({ root, provider: "github", write: true, preview: true });
    expect(result.content[0].text).not.toContain("secret-value");
    const workflow = await readFile(join(root, ".github/workflows/supacloud-deploy.yml"), "utf8");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("secrets.SUPACLOUD_DEPLOY_TOKEN");
    expect(workflow).toContain("SUPACLOUD_API_TOKEN");
    expect(workflow).toContain("secrets.SUPACLOUD_API_URL");
});

test("pipeline connect writes a plan-only workflow when a workspace map is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-pipeline-workspace-"));
    roots.push(root);
    await writeFile(join(root, "supacloud.workspace.json"), "{}\n");
    const result = await connectPipeline({ root, provider: "github", write: true, preview: true, format: "json" });
    const body = result.content[0]?.text ?? "";
    expect(body).toContain("\"workspace_plan_only\": true");
    expect(body).toContain("\"preview\": false");
    const workflow = await readFile(join(root, ".github/workflows/supacloud-deploy.yml"), "utf8");
    expect(workflow).toContain("workspace plan");
    expect(workflow).not.toContain("cli deploy");
    expect(workflow).not.toContain("SUPACLOUD_DEPLOY_TOKEN");
    expect(workflow).not.toContain("pull_request:");
});

test("a dangling workspace symlink never falls back to a deploy workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-pipeline-dangling-"));
    roots.push(root);
    await symlink(join(root, "missing-workspace.json"), join(root, "supacloud.workspace.json"));
    await expect(connectPipeline({ root, provider: "github", write: true })).rejects.toThrow("not a regular file");
    await expect(readFile(join(root, ".github/workflows/supacloud-deploy.yml"), "utf8")).rejects.toThrow();
});

test("an existing GitLab deploy workflow is left unchanged when a workspace map is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-pipeline-gitlab-workspace-"));
    roots.push(root);
    await writeFile(join(root, "supacloud.workspace.json"), "{}\n");
    await writeFile(join(root, ".gitlab-ci.yml"), "npx @supacloud/cli deploy\n");
    await expect(connectPipeline({ root, provider: "gitlab", write: true })).rejects.toThrow("left unchanged and can still deploy");
    expect(await readFile(join(root, ".gitlab-ci.yml"), "utf8")).toBe("npx @supacloud/cli deploy\n");
});

test("pipeline connect writes an executable GitLab CI workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-pipeline-gitlab-"));
    roots.push(root);
    const result = await connectPipeline({ root, provider: "gitlab", write: true });
    expect(result.content[0].text).toContain("written");
    const workflow = await readFile(join(root, ".gitlab-ci.yml"), "utf8");
    expect(workflow).toContain("supacloud_deploy:");
    expect(workflow).toContain("SUPACLOUD_API_TOKEN: $SUPACLOUD_DEPLOY_TOKEN");
    expect(workflow).toContain("npx @supacloud/cli deploy");
    await expect(connectPipeline({ root, provider: "gitlab", write: true })).rejects.toThrow("Refusing to overwrite");
});
