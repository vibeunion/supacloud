import { Elysia, t } from "elysia";
import type { VersionedPreheatRequest, WorkerPool } from "./worker-pool";

export const PROJECT_PREHEAT_SCHEMA = "supacloud.project-release-preheat.v1";

interface Epoch {
  runtime_instance_id: string;
  foreground_generation: number;
  background_generation: number;
}

interface Dependencies {
  authorize(request: Request): Response | undefined;
  epoch(): Epoch;
  assertAvailable(): void;
  prepare(ref: string, functions: Array<{ slug: string; version: string }>): Promise<{
    foreground: VersionedPreheatRequest[];
    background: VersionedPreheatRequest[];
    assertCurrent(): void;
  }>;
  foreground: Pick<WorkerPool, "preheatReleaseIdleWorkers">;
  background: Pick<WorkerPool, "preheatReleaseIdleWorkers">;
}

function sameEpoch(left: Epoch, right: Epoch): boolean {
  return left.runtime_instance_id === right.runtime_instance_id
    && left.foreground_generation === right.foreground_generation
    && left.background_generation === right.background_generation;
}

export function createProjectReleasePreheatRoutes(deps: Dependencies) {
  return new Elysia({ name: "project-release-preheat" })
    .post("/internal/project-release-preheat/:ref", {
      beforeHandle: ({ request }) => deps.authorize(request),
      params: t.Object({ ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }) }),
      body: t.Object({
        runtime_instance_id: t.String({ format: "uuid" }),
        foreground_generation: t.Integer({ minimum: 0 }),
        background_generation: t.Integer({ minimum: 0 }),
        functions: t.Array(t.Object({
          slug: t.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
          version: t.String({ pattern: "^[1-9][0-9]*$" }),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 128 }),
      }, { additionalProperties: false }),
    }, async ({ params, body, set }) => {
      try {
        deps.assertAvailable();
        if (!sameEpoch(deps.epoch(), body)) throw new Error("Runtime epoch changed");
        if (new Set(body.functions.map(entry => entry.slug)).size !== body.functions.length
          || body.functions.some(entry => entry.slug === "_project-release" || !Number.isSafeInteger(Number(entry.version)))) {
          throw new Error("Invalid release members");
        }
        const prepared = await deps.prepare(params.ref, body.functions);
        deps.assertAvailable();
        prepared.assertCurrent();
        if (!sameEpoch(deps.epoch(), body)) throw new Error("Runtime epoch changed");
        // Drain both pools before returning or releasing the caller's publication lock.
        const outcomes = await Promise.allSettled([
          deps.foreground.preheatReleaseIdleWorkers(prepared.foreground),
          deps.background.preheatReleaseIdleWorkers(prepared.background),
        ]);
        const foreground = outcomes[0]!;
        const background = outcomes[1]!;
        if (foreground.status === "rejected" || background.status === "rejected") {
          throw new Error("Release pool preparation failed");
        }
        deps.assertAvailable();
        prepared.assertCurrent();
        const after = deps.epoch();
        if (after.runtime_instance_id !== body.runtime_instance_id
          || after.foreground_generation !== body.foreground_generation + 1
          || after.background_generation !== body.background_generation + 1
          || foreground.value.length !== body.functions.length
          || background.value.length !== body.functions.length) {
          throw new Error("Runtime pools changed during release preheat");
        }
        const members = body.functions.map((entry, index) => {
          const fg = foreground.value[index]!;
          const bg = background.value[index]!;
          if (fg.rotation.generation !== after.foreground_generation
            || bg.rotation.generation !== after.background_generation
            || !fg.attestation || !bg.attestation) throw new Error("Release readiness is stale");
          return {
            slug: entry.slug,
            result: {
              preheated: `${params.ref}_${entry.slug}_v${entry.version}`,
              version: entry.version, success: true, attestation: fg.attestation,
              foreground: fg, background: bg,
            },
          };
        });
        return { schema: PROJECT_PREHEAT_SCHEMA, project_ref: params.ref, ...after, members };
      } catch {
        set.status = 409;
        return { code: "PROJECT_RELEASE_PREHEAT_FAILED" };
      }
    });
}
