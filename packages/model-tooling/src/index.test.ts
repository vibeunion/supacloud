import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remotePull, resolveReviewCandidate, runModelCommand } from "./index";

test("pull keeps maintained and generated model files outside the candidate boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-model-paths-"));
  try {
    expect(() => resolveReviewCandidate("zenstack/schema.zmodel", root)).toThrow("outside the maintained model");
    expect(() => resolveReviewCandidate("zenstack/generated/schema.zmodel", root)).toThrow("outside the maintained model");
    expect(resolveReviewCandidate("output/database-audit/model.zmodel", root)).toBe(join(root, "output/database-audit/model.zmodel"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote pull sends only Management API context and writes a review candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-model-tooling-"));
  const candidate = join(root, "output/database-audit/model.zmodel");
  const requests: Request[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request);
      expect(request.url).not.toContain("postgresql://");
      expect(request.headers.get("authorization")).toBe("Bearer management-token");
      return Response.json({
        schema: "supacloud.model-candidate.v1",
        candidate: 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n',
        warnings: ["review policies"],
      });
    },
  });
  const previous = {
    apiUrl: process.env["SUPACLOUD_API_URL"],
    token: process.env["SUPACLOUD_API_TOKEN"],
    ref: process.env["SUPACLOUD_PROJECT_REF"],
    database: process.env["SUPACLOUD_MODEL_DATABASE_URL"],
  };
  process.env["SUPACLOUD_API_URL"] = server.url.toString().replace(/\/$/, "");
  process.env["SUPACLOUD_API_TOKEN"] = "management-token";
  process.env["SUPACLOUD_PROJECT_REF"] = "project-ref";
  process.env["SUPACLOUD_MODEL_DATABASE_URL"] = "postgresql://user:secret@private.invalid/db";
  try {
    await remotePull(["--candidate", candidate, "--schema", "public,api"]);
    expect(await readFile(candidate, "utf8")).toContain("provider = \"postgresql\"");
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).searchParams.get("schema")).toBe("public,api");
  } finally {
    server.stop(true);
    if (previous.apiUrl === undefined) delete process.env["SUPACLOUD_API_URL"];
    else process.env["SUPACLOUD_API_URL"] = previous.apiUrl;
    if (previous.token === undefined) delete process.env["SUPACLOUD_API_TOKEN"];
    else process.env["SUPACLOUD_API_TOKEN"] = previous.token;
    if (previous.ref === undefined) delete process.env["SUPACLOUD_PROJECT_REF"];
    else process.env["SUPACLOUD_PROJECT_REF"] = previous.ref;
    if (previous.database === undefined) delete process.env["SUPACLOUD_MODEL_DATABASE_URL"];
    else process.env["SUPACLOUD_MODEL_DATABASE_URL"] = previous.database;
    await rm(root, { recursive: true, force: true });
  }
});

test("pull has no local database fallback", async () => {
  const previous = {
    apiUrl: process.env["SUPACLOUD_API_URL"],
    token: process.env["SUPACLOUD_API_TOKEN"],
    ref: process.env["SUPACLOUD_PROJECT_REF"],
    database: process.env["SUPACLOUD_MODEL_DATABASE_URL"],
  };
  delete process.env["SUPACLOUD_API_URL"];
  delete process.env["SUPACLOUD_API_TOKEN"];
  delete process.env["SUPACLOUD_PROJECT_REF"];
  process.env["SUPACLOUD_MODEL_DATABASE_URL"] = "postgresql://user:secret@private.invalid/db";
  try {
    await expect(runModelCommand(["pull", "--candidate", "output/model.zmodel"])).rejects.toThrow("SUPACLOUD_API_URL");
  } finally {
    if (previous.apiUrl === undefined) delete process.env["SUPACLOUD_API_URL"];
    else process.env["SUPACLOUD_API_URL"] = previous.apiUrl;
    if (previous.token === undefined) delete process.env["SUPACLOUD_API_TOKEN"];
    else process.env["SUPACLOUD_API_TOKEN"] = previous.token;
    if (previous.ref === undefined) delete process.env["SUPACLOUD_PROJECT_REF"];
    else process.env["SUPACLOUD_PROJECT_REF"] = previous.ref;
    if (previous.database === undefined) delete process.env["SUPACLOUD_MODEL_DATABASE_URL"];
    else process.env["SUPACLOUD_MODEL_DATABASE_URL"] = previous.database;
  }
});
