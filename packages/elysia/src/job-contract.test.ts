import { describe, expect, test } from "bun:test";
import { t } from "elysia";
import { executeJob, type CompiledModule } from "./index";

const inputSchema = t.Object({ id: t.String() });
const outputSchema = t.Object({ accepted: t.Boolean() });

function jobModule(
  run: (input: unknown) => unknown,
  hooks: { created?: () => void; destroyed?: () => void } = {},
): CompiledModule {
  return {
    name: "jobs",
    createServices: () => ({}),
    createJobScope: () => {
      hooks.created?.();
      return { job: { run } };
    },
    destroyJobScope: async () => {
      hooks.destroyed?.();
    },
    controllers: [],
    commands: [],
    jobs: [],
  };
}

function descriptor() {
  return {
    className: "AcceptJob",
    name: "case.accept",
    serviceKey: "job",
    scope: "job" as const,
    input: inputSchema,
    output: outputSchema,
  };
}

describe("executeJob contract boundaries", () => {
  test("rejects input before creating a scope and keeps submitted values private", async () => {
    let created = 0;
    let called = 0;
    const compiled = jobModule(() => {
      called += 1;
      return { accepted: true };
    }, { created: () => { created += 1; } });

    let error: unknown;
    try {
      await executeJob(compiled, {}, descriptor(), { id: 42, secret: "private-value" }, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "JOB_INPUT_VALIDATION_ERROR",
      status: 422,
    });
    expect(String(error)).not.toContain("private-value");
    expect(created).toBe(0);
    expect(called).toBe(0);
  });

  test("validates output after execution and still destroys the job scope", async () => {
    let destroyed = 0;
    let writes = 0;
    const compiled = jobModule(() => {
      writes += 1;
      return { accepted: "private-output" };
    }, { destroyed: () => { destroyed += 1; } });

    let error: unknown;
    try {
      await executeJob(compiled, {}, descriptor(), { id: "case-1" }, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "JOB_OUTPUT_VALIDATION_ERROR",
      status: 500,
    });
    expect(String(error)).not.toContain("private-output");
    expect(writes).toBe(1);
    expect(destroyed).toBe(1);
  });

  test("passes decoded input to the handler and returns decoded output", async () => {
    const compiled = jobModule((input) => ({ accepted: (input as { id: string }).id === "case-1" }));
    const result = await executeJob(compiled, {}, descriptor(), { id: "case-1" }, {});
    expect(result).toEqual({ accepted: true });
  });
});
