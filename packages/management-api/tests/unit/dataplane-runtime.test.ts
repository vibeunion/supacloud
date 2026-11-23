// @supacloud-test-isolate
import { describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import {
  DataPlaneUnavailableError,
  composeDataPlaneRuntimeStatus,
  dataPlaneDesiredState,
  dataPlaneUnit,
  dataPlaneRuntimeService,
  mapSystemdUnitState,
  type ProjectDataPlaneRow,
} from "../../src/services/dataplane-runtime.service";
import { renderDataPlaneSystemdTemplate } from "../../src/services/dataplane-systemd-template";

const row: ProjectDataPlaneRow = {
  status: "active",
  dataplane_desired: "running",
  dataplane_actual: "running",
  dataplane_health: "healthy",
  dataplane_port: 3110,
  dataplane_last_error: null,
  dataplane_updated_at: "2026-11-24T00:00:00.000Z",
};

describe("data plane desired state", () => {
  test("defaults to stopped so an unprovisioned project never looks live", () => {
    expect(dataPlaneDesiredState(null)).toBe("stopped");
    expect(dataPlaneDesiredState({ ...row, dataplane_desired: null })).toBe("stopped");
    expect(dataPlaneDesiredState({ ...row, dataplane_desired: "unknown-value" })).toBe("stopped");
  });

  test("only an explicit running desired state counts as running", () => {
    expect(dataPlaneDesiredState(row)).toBe("running");
  });
});

describe("systemd unit state mapping", () => {
  test("keeps a crashed unit visible as an error", () => {
    expect(mapSystemdUnitState("failed\n")).toBe("error");
  });

  test("distinguishes running, starting and stopped", () => {
    expect(mapSystemdUnitState("active")).toBe("running");
    expect(mapSystemdUnitState("activating")).toBe("starting");
    expect(mapSystemdUnitState("reloading")).toBe("starting");
    expect(mapSystemdUnitState("inactive")).toBe("stopped");
    expect(mapSystemdUnitState("unknown")).toBe("stopped");
  });
});

describe("data plane runtime status", () => {
  test("keeps the unit name and persisted port", () => {
    const status = composeDataPlaneRuntimeStatus("proj_abc", row, {
      actual: "running",
      health: "healthy",
      enabled: false,
    });
    expect(status).toMatchObject({
      component: "dataplane",
      unit: "supacloud-dataplane@proj_abc",
      port: 3110,
      desired: "running",
      actual: "running",
      health: "healthy",
      enabled: false,
      updated_at: "2026-11-24T00:00:00.000Z",
    });
  });

  test("reports a missing row as stopped with no port instead of throwing", () => {
    expect(composeDataPlaneRuntimeStatus("proj_abc", null, {
      actual: "stopped",
      health: "unknown",
      enabled: true,
    })).toMatchObject({ desired: "stopped", actual: "stopped", port: null, last_error: null });
  });

  test("surfaces a healthy-looking unit that fails its own health probe", () => {
    expect(composeDataPlaneRuntimeStatus("proj_abc", row, {
      actual: "running",
      health: "unhealthy",
      enabled: true,
    }).last_error).toBe("Data plane unit is active but /health did not report healthy");
  });

  test("preserves a previously recorded error over the derived one", () => {
    expect(composeDataPlaneRuntimeStatus("proj_abc", { ...row, dataplane_last_error: "port already bound" }, {
      actual: "error",
      health: "unknown",
      enabled: true,
    }).last_error).toBe("port already bound");
  });

  test("does not invent a unit name per project", () => {
    expect(dataPlaneUnit("abcdefghijkl")).toBe("supacloud-dataplane@abcdefghijkl");
  });
});

describe("data plane systemd template", () => {
  const rendered = renderDataPlaneSystemdTemplate({
    runtimeDir: "/etc/supacloud/dataplane",
    bunBinary: "/usr/local/bin/bun",
    entrypoint: "/usr/local/libexec/supacloud/dataplane-main.js",
    memoryMax: "512M",
    cpuWeight: 40,
  });

  test("keeps one unit per project with a graceful stop window", () => {
    expect(rendered).toContain("Description=SupaCloud Data API for tenant %i");
    expect(rendered).toContain("User=supacloud-%i");
    expect(rendered).toContain("KillSignal=SIGTERM");
    expect(rendered).toContain("TimeoutStopSec=30");
  });

  test("runs the bundled data plane entrypoint with the shared runtime directory", () => {
    expect(rendered).toContain("ExecStart=/usr/local/bin/bun /usr/local/libexec/supacloud/dataplane-main.js");
    expect(rendered).toContain('Environment="SUPACLOUD_DATAPLANE_RUNTIME_DIR=/etc/supacloud/dataplane"');
    expect(rendered).toContain("EnvironmentFile=-/etc/supacloud/dataplane/%i.env");
  });

  test("does not depend on PostgREST", () => {
    expect(rendered.toLowerCase()).not.toContain("postgrest");
  });
});
describe("data plane start gate", () => {
  test("distinguishes disabled from enabled-but-unprovisioned", async () => {
    const previous = config.dataPlaneEnabled;
    try {
      config.dataPlaneEnabled = false;
      await expect(dataPlaneRuntimeService.start("proj_1")).rejects.toMatchObject({
        code: "DATA_PLANE_DISABLED",
      });

      config.dataPlaneEnabled = true;
      await expect(dataPlaneRuntimeService.start("proj_1")).rejects.toMatchObject({
        code: "DATA_PLANE_NOT_PROVISIONED",
      });
    } finally {
      config.dataPlaneEnabled = previous;
    }
  });

  test("the refusal names the required next step", async () => {
    const previous = config.dataPlaneEnabled;
    config.dataPlaneEnabled = true;
    try {
      const error = await dataPlaneRuntimeService.start("proj_1").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DataPlaneUnavailableError);
      expect((error as Error).message).toContain("configuration generation");
    } finally {
      config.dataPlaneEnabled = previous;
    }
  });
});
