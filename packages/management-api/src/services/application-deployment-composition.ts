import { getProjectDb, resolveDbName, sql } from "../db";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";
import { gatewayService } from "./gateway.service";
import {
  ApplicationDeploymentService,
  type ApplicationDeploymentDependencies,
} from "./application-deployment";
import { createApplicationRoutes } from "../routes/applications";
import { ApplicationActiveStorage } from "./application-active-storage";
import { ApplicationConfigurations } from "./application-configuration";
import { ApplicationMigrations } from "./application-migrations";
import { ApplicationReadiness } from "./application-readiness";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { ApplicationSystemdRuntime } from "./application-runtime";
import { ApplicationRuntimeAllocations } from "./application-runtime-allocation";
import { ApplicationRuntimeFiles } from "./application-runtime-files";
import { createApplicationCompatibilityVerifier } from "./application-compatibility";

type CompatibilityInput = Parameters<
  NonNullable<ApplicationDeploymentDependencies["verifyCompatibility"]>
>[0];

function throwCompatibility(code: string): never {
  throw new Error(code);
}

/** Platform liveness preflight only; application schema and binding compatibility remain separate. */
export async function verifyApplicationPlatformAvailability(
  input: CompatibilityInput,
): Promise<void> {
  const projectRef = input.runtime.release.project_ref;
  const [project] = await sql`
    SELECT ref, status, db_name
    FROM projects
    WHERE ref = ${projectRef} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!project) throwCompatibility("APPLICATION_PROJECT_NOT_FOUND");
  if (String(project.status).toLowerCase() !== "active") {
    throwCompatibility("APPLICATION_PROJECT_RUNTIME_NOT_ACTIVE");
  }

  if (!input.migrations.ledger_compatible || !input.migrations.project_migrations_applied) {
    throwCompatibility("APPLICATION_MIGRATIONS_NOT_COMPATIBLE");
  }
  const targetNames = input.runtime.release.targets.map(target => target.name).sort();
  const environmentNames = Object.keys(input.environment).sort();
  if (targetNames.join("\0") !== environmentNames.join("\0")) {
    throwCompatibility("APPLICATION_RUNTIME_ENVIRONMENT_MISMATCH");
  }

  const runtime = await (await import("./tenant-runtime.service")).tenantRuntimeService.checkStatus(projectRef);
  if (runtime.status !== "running" || runtime.health !== "healthy") {
    throwCompatibility("APPLICATION_TENANT_RUNTIME_NOT_READY");
  }

  const postgrest = await (await import("./tenant-runtime.service"))
    .tenantRuntimeService.statusPostgrest(projectRef);
  if (postgrest.health !== "healthy" || postgrest.actual !== "running") {
    throwCompatibility("APPLICATION_POSTGREST_NOT_READY");
  }

  const auth = getAuthRuntimeDescriptor(projectRef);
  if (auth.authority_project_ref !== projectRef) {
    const [authority] = await sql`
      SELECT ref, status
      FROM projects
      WHERE ref = ${auth.authority_project_ref} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!authority || String(authority.status).toLowerCase() !== "active") {
      throwCompatibility("APPLICATION_AUTHORITY_PROJECT_NOT_READY");
    }
  }

  const databaseName = String(project.db_name || await resolveDbName(projectRef));
  const [identity] = await getProjectDb(databaseName)`
    SELECT 1 AS probe, current_database() AS database_name, current_user AS database_user
  `;
  if (!identity || Number(identity.probe) !== 1
    || String(identity.database_name) !== databaseName || !identity.database_user) {
    throwCompatibility("APPLICATION_PROJECT_DATABASE_NOT_READY");
  }
}

const verifyApplicationCompatibility = createApplicationCompatibilityVerifier();

/** Platform availability and a fresh operator-owned application probe are both mandatory. */
export async function verifyDefaultApplicationCompatibility(
  input: CompatibilityInput,
): Promise<void> {
  await verifyApplicationPlatformAvailability(input);
  await verifyApplicationCompatibility(input);
}

export function createDefaultApplicationRouteComposition(
  verifyCompatibility?: ApplicationDeploymentDependencies["verifyCompatibility"],
) {
  const verifier = verifyCompatibility ?? verifyDefaultApplicationCompatibility;
  const storage = new ApplicationReleaseStorage();
  const configurations = new ApplicationConfigurations();
  const active = new ApplicationActiveStorage();
  const migrations = new ApplicationMigrations({ storage });
  const readiness = new ApplicationReadiness();
  const allocations = new ApplicationRuntimeAllocations();
  const runtime = new ApplicationSystemdRuntime();
  const files = new ApplicationRuntimeFiles(storage);

  const dependencies: ApplicationDeploymentDependencies = {
    verifyCompatibility: verifyCompatibility === undefined ? verifier : async input => {
      await verifyApplicationPlatformAvailability(input);
      await verifier(input);
    },
    storage,
    configurations,
    active,
    migrations,
    readiness,
    allocations,
    files,
    runtime,
    gateway: gatewayService,
    retirementVerifier: async ({ allocation, configuration }) => {
      const gatewayInput = { runtime: allocation.runtime, hosts: configuration.hosts };
      await runtime.requireStopped(allocation.runtime);
      await gatewayService.verifyApplicationRouteAbsent(gatewayInput);
    },
  };

  const deployment = new ApplicationDeploymentService(dependencies);
  const routes = createApplicationRoutes({
    storage,
    configurations,
    active,
    migrations,
    readiness,
    deployment,
    retirementVerifier: dependencies.retirementVerifier,
  });
  return { deployment, routes };
}
