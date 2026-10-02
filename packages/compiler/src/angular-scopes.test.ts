import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderApplication } from "./generate";
import { migrateProject, SUPACLOUD_MIGRATIONS } from "./migrations";
import type { ApplicationGraph } from "./types";

/** Executes real generated request/job factories, not a replacement test DI container. */
test("generated request/job instances, disposal and cancellation stay owner-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "angular-scopes-"));
  try {
    const graph: ApplicationGraph = {
      externalTokens: ["REQUEST_CONTEXT", "JOB_CONTEXT"],
      modules: [{ name: "scoped", className: "ScopedModule", file: "source.ts", line: 1,
        imports: [], exports: [], controllers: [], commands: [], queries: [],
        providers: [
          { token: "Reader", tokenKind: "class", kind: "class", useClass: "Reader", importPath: "source",
            scope: "request", deps: ["REQUEST_CONTEXT"], hasOnDestroy: true, file: "source.ts", line: 1, exported: false },
          { token: "Worker", tokenKind: "class", kind: "class", useClass: "Worker", importPath: "source",
            scope: "job", deps: ["JOB_CONTEXT"], hasOnDestroy: true, file: "source.ts", line: 1, exported: false },
        ],
      }],
    };
    const code = renderApplication(graph, { rootDir: root, outDir: join(root, "generated") }).applicationCode;
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated/application.ts"), code);
    await writeFile(join(root, "source.ts"), `
export const released: string[] = [];
export class Reader {
  constructor(readonly context: { id: string; signal: AbortSignal }) {}
  async onDestroy() { await Promise.resolve(); released.push('request:' + this.context.id); }
}
export class Worker {
  constructor(readonly context: { id: string; signal: AbortSignal }) {}
  async onDestroy() { await Promise.resolve(); released.push('job:' + this.context.id); }
}
`);
    await writeFile(join(root, "runner.ts"), `
import { createCompiledModules } from './generated/application';
import { released } from './source';
export async function run() {
  const module = createCompiledModules()[0]!;
  if (!module.createRequestScope || !module.destroyRequestScope || !module.createJobScope || !module.destroyJobScope) throw new Error('Missing compiled scope contract');
  const services = module.createServices({}, {});
  const a = new AbortController(), b = new AbortController();
  const requestA = await module.createRequestScope(services, { id: 'a', signal: a.signal });
  const requestB = await module.createRequestScope(services, { id: 'b', signal: b.signal });
  const jobA = await module.createJobScope(services, { id: 'a', signal: a.signal });
  const jobB = await module.createJobScope(services, { id: 'b', signal: b.signal });
  const isolated = requestA.reader !== requestB.reader && jobA.worker !== jobB.worker;
  a.abort();
  await module.destroyRequestScope(requestA);
  await module.destroyJobScope(jobA);
  const first = [...released];
  const bActive = !b.signal.aborted;
  await module.destroyRequestScope(requestB);
  await module.destroyJobScope(jobB);
  return { isolated, bActive, first, released: [...released] };
}
`);
    const loaded: unknown = await import(pathToFileURL(join(root, "runner.ts")).href);
    if (!loaded || typeof loaded !== "object" || !("run" in loaded) || typeof loaded.run !== "function") throw new Error("Missing runner");
    expect(await loaded.run()).toEqual({ isolated: true, bActive: true,
      first: ["request:a", "job:a"], released: ["request:a", "job:a", "request:b", "job:b"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("HTTP migration is registered and previews before writing", async () => {
  expect(SUPACLOUD_MIGRATIONS.some(item => item.id === "http-provider-entrypoint")).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "http-migration-"));
  const file = join(root, "http.ts");
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors());`;
  try {
    await writeFile(file, source);
    const preview = await migrateProject({ rootDir: root });
    expect(preview.changedFiles).toEqual(["http.ts"]);
    expect(await readFile(file, "utf8")).toBe(source);
    const result = await migrateProject({ rootDir: root, write: true });
    expect(result.issues).toEqual([]);
    expect(await readFile(file, "utf8")).toContain("@supacloud/app/http");
    expect((await migrateProject({ rootDir: root, write: true })).changedFiles).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one ambiguous HTTP binding prevents every project write", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-migration-conflict-"));
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors());`;
  try {
    await writeFile(join(root, "a.ts"), source);
    await writeFile(join(root, "b.ts"), source + " const array = withInterceptors();");
    const result = await migrateProject({ rootDir: root, write: true });
    expect(result.issues.some(item => item.code === "http-provider-migration-ambiguous")).toBe(true);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe(source);
    expect(result.changedFiles).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
