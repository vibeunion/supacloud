/**
 * systemd template for the per-project data plane unit.
 *
 * The unit granularity matches PostgREST's (`supacloud-dataplane@<ref>`): one
 * process per project, so a failing data plane cannot take every project down
 * with it. Only the program behind the unit changes.
 *
 * Rendering does not enable the unit or switch any traffic. Provisioning and
 * the Caddy handover belong to the control-plane switch phase of
 * `docs/adr/2026-11-24-postgrest-dataplane-unification.md`.
 */

export type DataPlaneSystemdTemplateOptions = {
  /** Directory holding the rendered data plane environment files. */
  runtimeDir: string;
  /** Bun binary that runs `dataplane-main.js`. */
  bunBinary: string;
  /** Absolute path of the bundled data plane entrypoint. */
  entrypoint: string;
  /** Bun process memory cap, systemd syntax (for example `512M`). */
  memoryMax: string;
  /** systemd CPUWeight for the unit. */
  cpuWeight: number;
};

export function renderDataPlaneSystemdTemplate(options: DataPlaneSystemdTemplateOptions): string {
  return `
[Unit]
Description=SupaCloud Data API for tenant %i
Documentation=https://github.com/vibeunion/supacloud
After=network.target patroni.service
Wants=patroni.service
StartLimitBurst=3
StartLimitIntervalSec=60

[Service]
Type=simple
User=supacloud-%i
Group=supacloud-%i
Environment="SUPACLOUD_DATAPLANE_RUNTIME_DIR=${options.runtimeDir}"
EnvironmentFile=-${options.runtimeDir}/%i.env
ExecStart=${options.bunBinary} ${options.entrypoint}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=${options.runtimeDir}
MemoryMax=${options.memoryMax}
CPUWeight=${options.cpuWeight}

[Install]
WantedBy=multi-user.target
`.trim();
}