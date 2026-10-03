import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "../packages/compiler/node_modules/@typescript/typescript6/lib/typescript.js";
import { createClient } from "../packages/supacloud-js/node_modules/@supabase/supabase-js";
import {
  CommandAuthenticationError,
  createAuthenticatedFetch,
  type SingleAttemptFetch,
} from "../packages/supacloud-js/src/contracts";
import { createSupaCloudClient } from "../packages/supacloud-js/src/index";
import { renderClient } from "../packages/compiler/src/generate";
import type { ApplicationGraph } from "../packages/compiler/src/types";
import { writeFixtureProject } from "../packages/compiler/src/fixtures/helpers";

const repo = join(import.meta.dir, "..");

const graph: ApplicationGraph = {
  externalTokens: [],
  modules: [{
    name: "reviews", className: "ReviewsModule", file: "reviews.ts", line: 1,
    imports: [], providers: [], commands: [], queries: [], exports: [],
    controllers: [{
      className: "ReviewsController", path: "/reviews", scope: "request",
      deps: [], file: "reviews.ts", importPath: "./reviews",
      routes: [{ method: "POST", path: "/approve", handler: "approve" }],
    }],
  }],
};

interface GeneratedClientModule {
  createApiClient(config: {
    baseUrl: string;
    fetch: SingleAttemptFetch;
  }): {
    reviews: { approve(options: { body: { operationId: string } }): Promise<unknown> };
  };
}

let root: string;
let generated: GeneratedClientModule;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "supacloud-frontend-sdk-"));
  await writeFixtureProject(root, {
    "client.ts": renderClient(graph),
    "consumer.ts": [
      'import { createApiClient } from "./client";',
      `import { createAuthenticatedFetch } from ${JSON.stringify(join(repo, "packages/supacloud-js/src/contracts"))};`,
      'const getAccessToken = async (): Promise<string | null> => "synthetic-token";',
      "const transport = createAuthenticatedFetch({ getAccessToken });",
      'createApiClient({ baseUrl: "https://app.example.test", fetch: transport });',
      'createApiClient({ baseUrl: "https://app.example.test", fetch: globalThis.fetch });',
    ].join("\n"),
  });
  await symlink(join(repo, "packages/compiler/node_modules"), join(root, "node_modules"), "dir");
  generated = await import(pathToFileURL(join(root, "client.ts")).href);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("generated client accepts the SDK authenticated transport under Bun types without a cast", () => {
  const program = ts.createProgram([join(root, "consumer.ts")], {
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: ["bun"],
    typeRoots: [join(root, "node_modules/@types")],
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(diagnostics).toEqual([]);
});

test("the SDK and generated business client share one changing session resolver", async () => {
  let token: string | null = "session-one";
  let resolutions = 0;
  const getAccessToken = async () => { resolutions++; return token; };
  const supabase = createClient("https://project.example.test", "publishable-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const platform = createSupaCloudClient({
    supabase,
    projectRef: "project-ref",
    managementApiUrl: "https://management.example.test",
    getAccessToken,
  });
  expect(platform.supabase).toBe(supabase);

  const requests: Request[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.startsWith("https://management.example.test/")) {
      return Response.json({
        id: "11111111-1111-4111-8111-111111111111",
        project_ref: "project-ref",
        status: "succeeded",
      });
    }
    return Response.json({ approved: true });
  });
  try {
    const api = generated.createApiClient({
      baseUrl: "https://app.example.test",
      fetch: createAuthenticatedFetch({ getAccessToken }),
    });
    await platform.tasks.get("11111111-1111-4111-8111-111111111111");
    await expect(api.reviews.approve({ body: { operationId: "approval-1" } }))
      .resolves.toEqual({ approved: true });
    token = "session-two";
    await platform.tasks.get("11111111-1111-4111-8111-111111111111");
    await api.reviews.approve({ body: { operationId: "approval-2" } });
    expect(requests.map(request => request.headers.get("authorization"))).toEqual([
      "Bearer session-one", "Bearer session-one", "Bearer session-two", "Bearer session-two",
    ]);
    expect(requests.map(request => request.redirect)).toEqual(["error", "error", "error", "error"]);
    expect(resolutions).toBe(4);
    expect(await requests[1]!.json()).toEqual({ operationId: "approval-1" });

    token = null;
    await expect(api.reviews.approve({ body: { operationId: "approval-3" } }))
      .rejects.toBeInstanceOf(CommandAuthenticationError);
    expect(requests).toHaveLength(4);
  } finally {
    fetchMock.mockRestore();
  }
});

test.each(["unauthorized", "lost-response"] as const)(
  "generated writes never replay after %s",
  async failure => {
    let sends = 0;
    let resolutions = 0;
    const api = generated.createApiClient({
      baseUrl: "https://app.example.test",
      fetch: createAuthenticatedFetch({
        async getAccessToken() { resolutions++; return "synthetic-session"; },
        async fetch() {
          sends++;
          if (failure === "lost-response") throw new Error("Response lost after dispatch");
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        },
      }),
    });
    await expect(api.reviews.approve({ body: { operationId: "approval-1" } })).rejects.toThrow();
    expect({ sends, resolutions }).toEqual({ sends: 1, resolutions: 1 });
  },
);

test("invalid destinations and session resolution errors fail before sending", async () => {
  let sends = 0;
  const api = generated.createApiClient({
    baseUrl: "http://app.example.test",
    fetch: createAuthenticatedFetch({
      async getAccessToken() { return "synthetic-session"; },
      async fetch() { sends++; return Response.json({ approved: true }); },
    }),
  });
  await expect(api.reviews.approve({ body: { operationId: "approval-1" } }))
    .rejects.toThrow("HTTPS");
  const failedSession = generated.createApiClient({
    baseUrl: "https://app.example.test",
    fetch: createAuthenticatedFetch({
      async getAccessToken() { throw new Error("Session unavailable"); },
      async fetch() { sends++; return Response.json({ approved: true }); },
    }),
  });
  await expect(failedSession.reviews.approve({ body: { operationId: "approval-1" } }))
    .rejects.toThrow("Session unavailable");
  expect(sends).toBe(0);
});
