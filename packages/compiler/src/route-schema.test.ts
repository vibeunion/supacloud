import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "./analyze";
import { compileProject } from "./compile";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

test("analyzes headers, cookies and status-code response maps", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-route-schema-"));
  try {
    const controller = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace("import { Controller, Inject, Post, REQUEST_CONTEXT } from \"../../runtime\";", "import { Controller, Inject, Post, REQUEST_CONTEXT } from \"../../runtime\";")
      .replace("import { AcceptParams, AcceptResult, CreateCaseBody } from \"./contracts\";", "import { AcceptParams, AcceptResult, CreateCaseBody, RequestHeaders, RequestCookie, ConflictResult } from \"./contracts\";")
      .replace("response: AcceptResult,", "headers: RequestHeaders, cookie: RequestCookie, responses: { 201: AcceptResult, 409: ConflictResult },");
    const contracts = `${GOOD_PROJECT_FILES["src/features/case/contracts.ts"]}
export const RequestHeaders = { type: "object", properties: { authorization: { type: "string" } }, required: ["authorization"] };
export const RequestCookie = { type: "object", properties: { session: { type: "string" } }, required: ["session"] };
export const ConflictResult = { type: "object", properties: { conflict: { type: "boolean" } }, required: ["conflict"] };
`;
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": controller,
      "src/features/case/contracts.ts": contracts,
    });
    const graph = await analyzeProject(root);
    const route = graph.modules.find((module) => module.name === "case")?.controllers[0]?.routes[0];
    expect(route).toMatchObject({
      headers: "RequestHeaders",
      cookie: "RequestCookie",
      responses: { "201": "AcceptResult", "409": "ConflictResult" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves reusable defineRouteContract values passed to decorators", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-route-contract-reference-"));
  try {
    const controller = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace(
        'import { AcceptParams, AcceptResult, CreateCaseBody } from "./contracts";',
        'import { AcceptParams, AcceptResult, CreateCaseBody, RequestHeaders, RequestCookie, ConflictResult } from "./contracts";',
      )
      .replace(
        "@Controller(\"/cases\")",
        `const defineRouteContract = <T>(value: T): T => value;
const AcceptRoute = defineRouteContract({
  body: CreateCaseBody,
  params: AcceptParams,
  headers: RequestHeaders,
  cookie: RequestCookie,
  responses: { 201: AcceptResult, 409: ConflictResult },
  command: AcceptCaseCommand,
});

@Controller("/cases")`,
      )
      .replace(
        `@Post("/:caseId/accept", {
    body: CreateCaseBody,
    params: AcceptParams,
    response: AcceptResult,
    command: AcceptCaseCommand,
  })`,
        '@Post("/:caseId/accept", AcceptRoute)',
      );
    const contracts = `${GOOD_PROJECT_FILES["src/features/case/contracts.ts"]}
export const RequestHeaders = { type: "object", properties: { authorization: { type: "string" } }, required: ["authorization"] };
export const RequestCookie = { type: "object", properties: { session: { type: "string" } }, required: ["session"] };
export const ConflictResult = { type: "object", properties: { conflict: { type: "boolean" } }, required: ["conflict"] };
`;
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": controller,
      "src/features/case/contracts.ts": contracts,
    });
    const graph = await analyzeProject(root);
    const route = graph.modules.find((module) => module.name === "case")?.controllers[0]?.routes[0];
    expect(route).toMatchObject({
      body: "CreateCaseBody",
      params: "AcceptParams",
      headers: "RequestHeaders",
      cookie: "RequestCookie",
      responses: { "201": "AcceptResult", "409": "ConflictResult" },
      command: "AcceptCaseCommand",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated clients decode declared responses without a caller decoder", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-contract-"));
  try {
    const controller = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace("import { Controller, Inject, Post, REQUEST_CONTEXT } from \"../../runtime\";", "import { Controller, Inject, Post, REQUEST_CONTEXT } from \"../../runtime\";")
      .replace("import { AcceptParams, AcceptResult, CreateCaseBody } from \"./contracts\";", "import { AcceptParams, AcceptResult, CreateCaseBody, RequestHeaders, RequestCookie, ConflictResult } from \"./contracts\";")
      .replace("response: AcceptResult,", "headers: RequestHeaders, cookie: RequestCookie, responses: { 201: AcceptResult, 409: ConflictResult },");
    const contracts = `${GOOD_PROJECT_FILES["src/features/case/contracts.ts"]}
export const RequestHeaders = { type: "object", properties: { authorization: { type: "string" } }, required: ["authorization"] };
export const RequestCookie = { type: "object", properties: { session: { type: "string" } }, required: ["session"] };
export const ConflictResult = { type: "object", properties: { conflict: { type: "boolean" } }, required: ["conflict"] };
`;
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": controller,
      "src/features/case/contracts.ts": contracts,
    });
    const outDir = join(root, "generated");
    const result = await compileProject({ rootDir: root, outDir, generateClient: true });
    expect(result.diagnostics).toEqual([]);
    const clientCode = await readFile(join(outDir, "client.ts"), "utf8");
    expect(clientCode).toContain("decodeResponseSchema");
    expect(clientCode).toContain('responses: { "201": AcceptResult, "409": ConflictResult }');
    const module = await import(pathToFileURL(join(outDir, "client.ts")).href);
    const client = module.createApiClient({
      baseUrl: "https://example.test",
      fetch: async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("cookie")).toBe("session=s-1");
        return Response.json({ ok: true }, { status: 201 });
      },
    });
    const response = await client.case.accept({
      params: { caseId: "case-1" },
      body: { title: "Example" },
      headers: { authorization: "Bearer test" },
      cookie: { session: "s-1" },
    });
    expect(response).toEqual({ ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects response selectors that cannot be represented by the Elysia adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-route-response-selector-"));
  try {
    const controller = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace("import { AcceptParams, AcceptResult, CreateCaseBody } from \"./contracts\";", "import { AcceptParams, AcceptResult, CreateCaseBody } from \"./contracts\";")
      .replace(
        "response: AcceptResult,",
        'responses: { "4XX": AcceptResult, fallback: AcceptResult },',
      );
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": controller,
    });
    const graph = await analyzeProject(root);
    expect(graph.diagnostics?.some((diagnostic) =>
      diagnostic.code === "invalid-route-response-selector" && diagnostic.errorCode === "SC3025",
    )).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects routes that declare both response contract fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-route-response-conflict-"));
  try {
    const controller = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace(
        "response: AcceptResult,",
        "response: AcceptResult, responses: { 200: AcceptResult },",
      );
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": controller,
    });
    const graph = await analyzeProject(root);
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "conflicting-route-response-schema",
      errorCode: "SC3026",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects response-family selector variants that differ only by case", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-route-response-duplicate-"));
  try {
    const controller = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace(
        "response: AcceptResult,",
        'responses: { "4XX": AcceptResult, "4xx": AcceptResult },',
      );
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": controller,
    });
    const graph = await analyzeProject(root);
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "duplicate-route-response-selector",
      errorCode: "SC3027",
    }));
    const route = graph.modules.find((module) => module.name === "case")?.controllers[0]?.routes[0];
    expect(route?.responses).toEqual({ "4XX": "AcceptResult" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate exact response selectors before generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-route-response-exact-duplicate-"));
  try {
    const controller = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace(
        "response: AcceptResult,",
        'responses: { "200": AcceptResult, 200: AcceptResult },',
      );
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": controller,
    });
    const graph = await analyzeProject(root);
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "duplicate-route-response-selector",
      errorCode: "SC3027",
    }));
    const route = graph.modules.find((module) => module.name === "case")?.controllers[0]?.routes[0];
    expect(route?.responses).toEqual({ "200": "AcceptResult" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
