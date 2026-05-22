/**
 * Platform-level service checks.
 * Wraps the existing HealthChecker into the diagnostics framework.
 */
import { $ } from "bun";
import { hashPayload, statusForHash } from "../hash";
import { registerCheck } from "../../services/diagnostics.registry";
import type { DiagnosticCheckResult, DiagnosticRepairResult } from "../../services/diagnostics.types";

// --- Systemd service check ---
registerCheck({
  id: "platform-service-status",
  name: "Platform Services",
  description: "Check critical systemd services: supacloud, kong, supacloud-edge-runtime",
  category: "service",
  scope: "platform",
  severity: "critical",
  repairable: false,
  async run(): Promise<DiagnosticCheckResult | null> {
    const services = [
      { unit: "supacloud", label: "Management API" },
      { unit: "kong", label: "Kong Gateway" },
      { unit: "supacloud-edge-runtime", label: "Edge Runtime" },
      { unit: "patroni", label: "Patroni (PostgreSQL HA)" },
    ];

    const failed: string[] = [];
    const ok: string[] = [];

    for (const svc of services) {
      try {
        const result = await $`systemctl is-active ${svc.unit}`.nothrow().quiet();
        if (result.exitCode === 0) {
          ok.push(svc.label);
        } else {
          failed.push(svc.label);
        }
      } catch {
        failed.push(svc.label);
      }
    }

    if (failed.length > 0) {
      return {
        checkId: "platform-service-status",
        status: "degraded",
        message: `Services down: ${failed.join(", ")}`,
        detail: `Running: ${ok.join(", ") || "none"}`,
        metadata: { failed, ok },
      };
    }

    return {
      checkId: "platform-service-status",
      status: "pass",
      message: `All ${services.length} critical services running`,
    };
  },
});

// --- Port listener check ---
registerCheck({
  id: "platform-port-listeners",
  name: "Port Listeners",
  description: "Verify expected ports are listening: 9090 (API), 8000/8443 (Kong), 9000 (Edge Runtime)",
  category: "service",
  scope: "platform",
  severity: "critical",
  repairable: false,
  async run(): Promise<DiagnosticCheckResult | null> {
    const ports = [
      { port: 9090, label: "Management API" },
      { port: 8000, label: "Kong HTTP" },
      { port: 8443, label: "Kong HTTPS" },
      { port: 9000, label: "Edge Runtime" },
      { port: 5432, label: "PostgreSQL" },
    ];

    const notListening: string[] = [];
    const listening: string[] = [];

    for (const p of ports) {
      try {
        const result = await $`ss -tlnp sport = :${String(p.port)}`.nothrow().quiet();
        if (result.stdout.toString().includes(String(p.port))) {
          listening.push(`${p.label}(:${p.port})`);
        } else {
          notListening.push(`${p.label}(:${p.port})`);
        }
      } catch {
        notListening.push(`${p.label}(:${p.port})`);
      }
    }

    if (notListening.length > 0) {
      return {
        checkId: "platform-port-listeners",
        status: "degraded",
        message: `Ports not listening: ${notListening.join(", ")}`,
        detail: `Listening: ${listening.join(", ") || "none"}`,
        metadata: { notListening, listening },
      };
    }

    return {
      checkId: "platform-port-listeners",
      status: "pass",
      message: `All ${ports.length} expected ports are listening`,
    };
  },
});

// --- Disk space check ---
registerCheck({
  id: "platform-disk-space",
  name: "Disk Space",
  description: "Check available disk space on critical mount points",
  category: "service",
  scope: "platform",
  severity: "warning",
  repairable: false,
  async run(): Promise<DiagnosticCheckResult | null> {
    try {
      const output = await $`df -h /opt /var | awk 'NR>1 {print $6, $4, $5}'`.text();
      const lines = output.trim().split("\n");
      const lowSpace: string[] = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const [mount, avail, usePct] = parts;
          const useNum = parseInt(usePct);
          if (useNum > 90 || avail.endsWith("M")) {
            lowSpace.push(`${mount}: ${avail} available (${usePct} used)`);
          }
        }
      }

      if (lowSpace.length > 0) {
        return {
          checkId: "platform-disk-space",
          status: "degraded",
          message: `Low disk space: ${lowSpace.join("; ")}`,
        };
      }

      return {
        checkId: "platform-disk-space",
        status: "pass",
        message: "Disk space sufficient on all mount points",
      };
    } catch {
      return {
        checkId: "platform-disk-space",
        status: "error",
        message: "Cannot check disk space",
      };
    }
  },
});

// --- API health probe ---
registerCheck({
  id: "platform-api-health",
  name: "API Health Probe",
  description: "Synthetic probe: GET /v1/system/info and internal health endpoints",
  category: "api_probe",
  scope: "platform",
  severity: "critical",
  repairable: false,
  async run(): Promise<DiagnosticCheckResult | null> {
    const probes = [
      { url: "http://127.0.0.1:9090/v1/system/info", label: "System Info" },
      { url: "http://127.0.0.1:9090/health", label: "API Health" },
    ];

    const failed: string[] = [];

    for (const probe of probes) {
      try {
        const res = await fetch(probe.url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
          failed.push(`${probe.label} (HTTP ${res.status})`);
        }
      } catch (err: unknown) {
        failed.push(`${probe.label} (${err instanceof Error ? err.message : "unreachable"})`);
      }
    }

    if (failed.length > 0) {
      return {
        checkId: "platform-api-health",
        status: "unreachable",
        message: `API probes failed: ${failed.join("; ")}`,
      };
    }

    return {
      checkId: "platform-api-health",
      status: "pass",
      message: "All API health probes OK",
    };
  },
});

// --- Management DB connectivity ---
registerCheck({
  id: "platform-management-db",
  name: "Management Database",
  description: "Verify management database is reachable and core tables exist",
  category: "database_schema",
  scope: "platform",
  severity: "critical",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    try {
      const [result] = await ctx.metaDb`
        SELECT count(*) as cnt FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('organizations', 'projects', 'project_tasks', 'audit_logs', 'platform_settings')
      `;
      const count = Number((result as any)?.cnt ?? 0);

      if (count < 5) {
        return {
          checkId: "platform-management-db",
          status: "missing",
          message: `Only ${count}/5 core management tables found`,
          detail: "Database may not be fully initialized",
        };
      }

      return {
        checkId: "platform-management-db",
        status: "pass",
        message: `Management DB healthy, ${count} core tables present`,
      };
    } catch (err: unknown) {
      return {
        checkId: "platform-management-db",
        status: "unreachable",
        message: `Cannot query management DB: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// --- Project state consistency ---
registerCheck({
  id: "platform-project-state-consistency",
  name: "Project State Consistency",
  description: "Check active projects have running PostgREST and healthy runtime",
  category: "configuration",
  scope: "platform",
  severity: "warning",
  repairable: true,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    try {
      const projects = await ctx.metaDb`
        SELECT ref, status, postgrest_desired, postgrest_actual, postgrest_health, postgrest_last_error
        FROM projects
        WHERE deleted_at IS NULL AND lower(status) = 'active'
        LIMIT 50
      `;

      const inconsistent: string[] = [];
      for (const p of projects as any[]) {
        const desired = p.postgrest_desired ?? "running";
        if (desired !== "running" || p.postgrest_actual !== "running" || p.postgrest_health !== "healthy") {
          inconsistent.push(
            `${p.ref}: desired=${p.postgrest_desired ?? "?"} actual=${p.postgrest_actual ?? "?"} health=${p.postgrest_health ?? "?"} err=${p.postgrest_last_error ?? "none"}`,
          );
        }
      }

      if (inconsistent.length > 0) {
        return {
          checkId: "platform-project-state-consistency",
          status: "degraded",
          message: `${inconsistent.length}/${projects.length} active projects have inconsistent runtime state`,
          detail: inconsistent.slice(0, 10).join("\n"),
          repairPreview: "Restart unhealthy PostgREST instances for affected projects",
          repairCommand: `POST /v1/diagnostics/results/:id/repair`,
          metadata: { count: inconsistent.length, refs: inconsistent.slice(0, 20) },
        };
      }

      return {
        checkId: "platform-project-state-consistency",
        status: "pass",
        message: `All ${projects.length} active projects have consistent runtime state`,
      };
    } catch (err: unknown) {
      return {
        checkId: "platform-project-state-consistency",
        status: "error",
        message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  async repair(ctx): Promise<DiagnosticRepairResult> {
    try {
      const projects = await ctx.metaDb`
        SELECT ref FROM projects
        WHERE deleted_at IS NULL AND lower(status) = 'active'
          AND (
            COALESCE(postgrest_desired, 'running') <> 'running'
            OR COALESCE(postgrest_actual, '') <> 'running'
            OR COALESCE(postgrest_health, '') <> 'healthy'
          )
        LIMIT 20
      `;

      const { tenantRuntimeService } = await import("../../services/tenant-runtime.service");
      let repaired = 0;
      for (const p of projects as any[]) {
        try {
          await tenantRuntimeService.restartPostgrest(p.ref);
          repaired++;
        } catch {
          // best effort
        }
      }

      return {
        success: true,
        message: `Restarted PostgREST for ${repaired} unhealthy projects`,
        appliedCommand: `tenantRuntimeService.restartPostgrest() x${repaired}`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `Repair failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// --- Platform config hash baseline ---
registerCheck({
  id: "platform-config-hash",
  name: "Platform Config Baseline",
  description: "Hash non-secret platform settings and project config summary",
  category: "configuration",
  scope: "platform",
  severity: "critical",
  repairable: false,
  async run(ctx): Promise<DiagnosticCheckResult | null> {
    try {
      const [settings, projects] = await Promise.all([
        ctx.metaDb`
          SELECT key, value, is_secret
          FROM platform_settings
          WHERE is_secret = false
          ORDER BY key
        `,
        ctx.metaDb`
          SELECT ref, status, region, postgrest_desired, config
          FROM projects
          WHERE deleted_at IS NULL
          ORDER BY ref
        `,
      ]);
      const hash = hashPayload({ settings, projects });
      const baseline = await statusForHash(ctx, "platform-config-hash", hash);

      return {
        checkId: "platform-config-hash",
        status: baseline.status,
        message: baseline.status === "tampered" ? "Platform config differs from trusted baseline" : "Platform config hash matches baseline or no baseline exists",
        detail: `sha256:${hash}`,
        metadata: {
          hash,
          baselineHash: baseline.baselineHash,
          settings: settings.length,
          projects: projects.length,
        },
      };
    } catch (err: unknown) {
      return {
        checkId: "platform-config-hash",
        status: "error",
        message: `Cannot compute platform config hash: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
