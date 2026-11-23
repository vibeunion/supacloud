/**
 * Data plane runtime observations for a project.
 *
 * This is the phase-2 control surface skeleton described by
 * `docs/adr/2026-11-24-postgrest-dataplane-unification.md`: it reports observed
 * state and can stop a stale unit, but it does not provision or start one.
 * Starting requires generated configuration and a persisted port, which do not
 * exist yet; pretending otherwise would create a second, untracked data path.
 */

import { $ } from "bun";
import { config } from "../config";
import { sql as metaSql } from "../db";

export type DataPlaneDesiredState = "running" | "stopped";
export type DataPlaneActualState = "running" | "starting" | "stopped" | "error";

export interface DataPlaneRuntimeStatus {
  component: "dataplane";
  desired: DataPlaneDesiredState;
  actual: DataPlaneActualState;
  health: "healthy" | "unhealthy" | "unknown";
  port: number | null;
  unit: string;
  last_error: string | null;
  updated_at: string | null;
  /** Operator flag: whether the data plane may be started at all. */
  enabled: boolean;
}

export class DataPlaneUnavailableError extends Error {
  constructor(
    readonly code: "DATA_PLANE_DISABLED" | "DATA_PLANE_NOT_PROVISIONED",
    message: string,
  ) {
    super(message);
    this.name = "DataPlaneUnavailableError";
  }
}

export function dataPlaneUnit(projectRef: string): string {
  return `supacloud-dataplane@${projectRef}`;
}

export interface ProjectDataPlaneRow {
  status: string | null;
  dataplane_desired: string | null;
  dataplane_actual: string | null;
  dataplane_health: string | null;
  dataplane_port: number | null;
  dataplane_last_error: string | null;
  dataplane_updated_at: Date | string | null;
}

async function readRow(projectRef: string): Promise<ProjectDataPlaneRow | null> {
  const [row] = await metaSql`
    SELECT status,
           dataplane_desired,
           dataplane_actual,
           dataplane_health,
           dataplane_port,
           dataplane_last_error,
           dataplane_updated_at
    FROM projects
    WHERE ref = ${projectRef} AND deleted_at IS NULL
    LIMIT 1
  `;
  return (row as ProjectDataPlaneRow | undefined) ?? null;
}

/** Desired state defaults to `stopped`: nothing is provisioned until phase 2. */
export function dataPlaneDesiredState(row: ProjectDataPlaneRow | null): DataPlaneDesiredState {
  if (row?.dataplane_desired === "running") return "running";
  return "stopped";
}

/**
 * Compose a runtime status from a persisted row and one observation.
 *
 * Pure on purpose: the persisted-vs-observed merge is the part that must not
 * drift, and it is testable without systemd or a database.
 */
export function composeDataPlaneRuntimeStatus(
  projectRef: string,
  row: ProjectDataPlaneRow | null,
  observed: {
    actual: DataPlaneActualState;
    health: DataPlaneRuntimeStatus["health"];
    enabled: boolean;
  },
): DataPlaneRuntimeStatus {
  const lastError = localObservationError(row, observed.actual, observed.health);
  return {
    component: "dataplane",
    desired: dataPlaneDesiredState(row),
    actual: observed.actual,
    health: observed.health,
    port: row?.dataplane_port ?? null,
    unit: dataPlaneUnit(projectRef),
    last_error: lastError,
    updated_at: row?.dataplane_updated_at ? new Date(row.dataplane_updated_at).toISOString() : null,
    enabled: observed.enabled,
  };
}

/**
 * Map a `systemctl is-active` token onto a runtime state.
 *
 * `failed` must not collapse into `stopped`: a unit that crashed on startup is
 * an error an operator has to see, not a clean shutdown.
 */
export function mapSystemdUnitState(state: string): DataPlaneActualState {
  switch (state.trim()) {
    case "active":
      return "running";
    case "activating":
    case "reloading":
      return "starting";
    case "failed":
      return "error";
    default:
      return "stopped";
  }
}

async function observeUnit(unit: string): Promise<DataPlaneActualState> {
  const result = await $`systemctl is-active ${unit}`.nothrow().quiet();
  return mapSystemdUnitState(result.stdout.toString());
}

async function probeHealth(port: number | null): Promise<"healthy" | "unhealthy" | "unknown"> {
  if (port === null) return "unknown";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return "unhealthy";
    const body = await response.json() as { status?: unknown };
    return body.status === "healthy" ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

async function persistObservation(
  projectRef: string,
  observation: {
    actual: DataPlaneActualState;
    health: DataPlaneRuntimeStatus["health"];
    last_error: string | null;
  },
): Promise<void> {
  await metaSql`
    UPDATE projects
    SET dataplane_actual = ${observation.actual},
        dataplane_health = ${observation.health},
        dataplane_last_error = ${observation.last_error},
        dataplane_updated_at = NOW()
    WHERE ref = ${projectRef} AND deleted_at IS NULL
  `;
}

export const dataPlaneRuntimeService = {
  unit: dataPlaneUnit,

  get enabled(): boolean {
    return config.dataPlaneEnabled;
  },

  /** Read observed state, optionally writing it back for reconcile consumers. */
  async status(projectRef: string, opts: { persistObservation?: boolean } = {}): Promise<DataPlaneRuntimeStatus> {
    const row = await readRow(projectRef);
    if (!row) throw new Error(`Project ${projectRef} not found`);

    const actual = await observeUnit(dataPlaneUnit(projectRef));
    const health = await probeHealth(row.dataplane_port);
    const status = composeDataPlaneRuntimeStatus(projectRef, row, {
      actual,
      health,
      enabled: config.dataPlaneEnabled,
    });

    if (opts.persistObservation !== false) {
      await persistObservation(projectRef, {
        actual,
        health,
        last_error: status.last_error,
      });
    }

    return status;
  },

  /**
   * Stop a data plane unit and record the desired state.
   *
   * Stopping is safe: it removes a listener and leaves PostgREST untouched, so
   * it is also the rollback action while both planes coexist.
   */
  async stop(projectRef: string): Promise<DataPlaneRuntimeStatus> {
    const unit = dataPlaneUnit(projectRef);
    await metaSql`
      UPDATE projects SET dataplane_desired = 'stopped', dataplane_updated_at = NOW()
      WHERE ref = ${projectRef} AND deleted_at IS NULL
    `;
    const stopResult = await $`systemctl stop ${unit}`.nothrow().quiet();
    await $`systemctl disable ${unit}`.nothrow().quiet();
    const status = await this.status(projectRef);
    if (stopResult.exitCode !== 0 && status.actual === "running") {
      throw new Error(`Data plane unit ${unit} did not stop`);
    }
    return status;
  },

  /**
   * Refuse to start until configuration generation, port persistence and the
   * switch gate exist. The error codes are stable so routes can map them.
   */
  async start(_projectRef: string): Promise<never> {
    throw new DataPlaneUnavailableError(
      "DATA_PLANE_DISABLED",
      config.dataPlaneEnabled
        ? "Data plane start is not provisioned yet: configuration generation and port persistence land with the control-plane switch"
        : "Data plane is disabled (DATA_PLANE_ENABLED=false); PostgREST remains the project REST data plane",
    );
  },
};

function localObservationError(
  row: ProjectDataPlaneRow | null,
  actual: DataPlaneActualState,
  health: DataPlaneRuntimeStatus["health"],
): string | null {
  if (row && typeof row.dataplane_last_error === "string" && row.dataplane_last_error.length > 0) {
    return row.dataplane_last_error;
  }
  if (actual === "running" && health === "unhealthy") {
    return "Data plane unit is active but /health did not report healthy";
  }
  return null;
}