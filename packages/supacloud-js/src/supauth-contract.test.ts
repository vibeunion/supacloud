import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as ts from "../../compiler/node_modules/@typescript/typescript6/lib/typescript.js";
import { createSupaCloudClient, createSupaCloudOAuthFetch } from "./index";

test("the public SDK does not expose unsupported SupAuth orchestration or access credentials at construction", () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  let tokenReads = 0;
  try {
    const supabase = createClient("https://project.example.com", "anon-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "https://management.example.com", projectRef: "proj_1",
      getAccessToken: () => { tokenReads++; return "management-token"; },
    });
    expect("supauth" in client).toBe(false);
    expect(client.supabase).toBe(supabase);
    expect(typeof client.auth.oauthServer.getStatus).toBe("function");
    expect(typeof client.auth.oauthServer.migrateToOidc).toBe("function");
    expect(typeof client.auth.oauthClients.list).toBe("function");
    expect(typeof createSupaCloudOAuthFetch).toBe("function");
    expect(tokenReads).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

test("compiler symbols omit the retired namespace and DTOs from the real source API", () => {
  // Symbol inspection is scoped evidence, not a substitute for the TS7 consumer gate.
  const entry = join(import.meta.dir, "index.ts");
  const program = ts.createProgram([entry], {
    noEmit: true, strict: true, skipLibCheck: false,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error("SDK entrypoint was not loaded");
  const module = checker.getSymbolAtLocation(source);
  if (!module) throw new Error("SDK module did not resolve");
  const exports = checker.getExportsOfModule(module);
  expect(exports.some(symbol => symbol.name.startsWith("SupaCloudSupAuth"))).toBe(false);
  const factory = exports.find(symbol => symbol.name === "createSupaCloudClient");
  if (!factory) throw new Error("SDK client factory is missing");
  const signatures = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(factory, source), ts.SignatureKind.Call);
  expect(signatures).toHaveLength(1);
  const signature = signatures[0];
  if (!signature) throw new Error("SDK client signature is missing");
  const client = checker.getReturnTypeOfSignature(signature);
  const fields = checker.getPropertiesOfType(client).map(field => field.name);
  expect(fields).not.toContain("supauth");
  for (const field of ["supabase", "auth", "tasks", "queues", "queue", "workflows", "commands", "artifacts", "functions"]) {
    expect(fields).toContain(field);
  }
});

test("actual Management route tables expose Auth management but no SupAuth orchestration", async () => {
  const plugins = await import("../../management-api/src/routes");
  const routes = Object.values(plugins).flatMap(plugin =>
    plugin.routes.map(route => ({ method: route.method, path: route.path })),
  );
  expect(routes).toContainEqual({ method: "GET", path: "/v1/projects/:ref/auth/oauth-server" });
  expect(routes).toContainEqual({ method: "GET", path: "/v1/projects/:ref/auth/runtime" });
  expect(routes).toContainEqual({ method: "GET", path: "/v1/projects/:ref/auth/oauth-clients" });
  expect(routes.filter(route => /\/supauth(?:\/|$)/.test(route.path))).toEqual([]);
});
