import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";

test("generated request and job scopes receive only their declared external dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-scoped-deps-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/feature.ts": `
        import { InjectionToken, Inject, Injectable, Module, Job, JOB_CONTEXT, REQUEST_CONTEXT } from "./runtime";
        export const DB_CLIENT = new InjectionToken("db-client");
        export const DESTROY_REF = new InjectionToken("supacloud.destroy-ref");
        @Injectable()
        export class OwnedService {
          destroyed = false;
          onDestroy() { this.destroyed = true; }
        }
        @Injectable({ scope: "job" })
        @Job({ name: "attachments.verify" })
        export class AttachmentJob {
          constructor(@Inject(DB_CLIENT) readonly db: unknown, @Inject(JOB_CONTEXT) readonly context: unknown,
            @Inject(DESTROY_REF) readonly destroyRef: unknown) {}
          run() { return this.db; }
        }
        @Injectable({ scope: "request" })
        export class RequestReader {
          constructor(@Inject(DB_CLIENT) readonly db: unknown, @Inject(REQUEST_CONTEXT) readonly context: unknown) {}
        }
        @Module({ name: "attachments", providers: [OwnedService, AttachmentJob, RequestReader], jobs: [AttachmentJob] })
        export class AttachmentsModule {}
      `,
    });
    const compiled = await compileProject({ rootDir: root, outDir: join(root, "generated") });
    expect(compiled.diagnostics).toEqual([]);
    const generated = await import(pathToFileURL(join(root, "generated/application.ts")).href);
    const module = generated.createCompiledModules()[0];
    let hostDestroyed = 0;
    const dbClient = { name: "owned-database", onDestroy() { hostDestroyed++; } };
    const destroyRef = { destroy() { hostDestroyed++; } };
    const services = module.createServices({ dbClient, destroyRef, unrelatedSecret: "not-forwarded" }, {});
    expect(services.dbClient).toBe(dbClient);
    expect(services).not.toHaveProperty("unrelatedSecret");
    expect(Object.keys(services)).not.toContain("dbClient");
    const context = { id: "job-1" };
    const job = await module.createJobScope(services, context);
    expect(job.attachmentJob.db).toBe(dbClient);
    expect(job.attachmentJob.context).toBe(context);
    expect(job.attachmentJob.destroyRef).toBe(destroyRef);
    const request = await module.createRequestScope(services, context);
    expect(request.requestReader.db).toBe(dbClient);
    expect(request.requestReader.context).toBe(context);
    expect((await module.createJobScope(services, {})).attachmentJob).not.toBe(job.attachmentJob);
    await module.destroyJobScope(job);
    await module.destroyRequestScope(request);
    expect(hostDestroyed).toBe(0);
    await generated.destroyApplication(services);
    expect(services.ownedService.destroyed).toBe(true);
    expect(hostDestroyed).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
