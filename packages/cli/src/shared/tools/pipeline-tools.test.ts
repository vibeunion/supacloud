import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
