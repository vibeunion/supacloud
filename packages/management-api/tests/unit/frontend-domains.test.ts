import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFrontendDomain } from "../../src/utils/frontend-domains";

const fixtureDirs: string[] = [];

async function deploymentFixture(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supacloud-frontends-"));
  fixtureDirs.push(root);
  const deploymentDir = join(root, "project-a", "deployment-a");
  await mkdir(deploymentDir, { recursive: true });
  await writeFile(join(deploymentDir, "deployment.json"), JSON.stringify(config));
  return root;
}

afterEach(async () => {
  await Promise.all(fixtureDirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("isFrontendDomain", () => {
  test("matches registered domains exactly after DNS normalization", async () => {
    const root = await deploymentFixture({
      domain: "MyApp.Example.COM.",
      custom_domains: ["WWW.Example.com"],
      status: "success",
    });

    await expect(isFrontendDomain("myapp.example.com", root)).resolves.toBe(true);
    await expect(isFrontendDomain("www.example.com.", root)).resolves.toBe(true);
    await expect(isFrontendDomain("other.example.com", root)).resolves.toBe(false);
  });

  test("does not authorize deleted frontend deployments", async () => {
    const root = await deploymentFixture({
      domain: "deleted.example.com",
      custom_domains: ["alias.example.com"],
      status: "deleted",
    });

    await expect(isFrontendDomain("deleted.example.com", root)).resolves.toBe(false);
    await expect(isFrontendDomain("alias.example.com", root)).resolves.toBe(false);
  });
});
