import path from "node:path";

export type PostgrestSystemdTemplateOptions = {
  postgrestRts: string;
  postgrestBinary: string;
  tenantConfigDir: string;
  memoryMax: string;
  cpuWeight: number;
};

export function renderPostgrestSystemdTemplate(options: PostgrestSystemdTemplateOptions): string {
  return `
[Unit]
Description=SupaCloud PostgREST for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=supacloud-%i
Group=supacloud-%i
Environment="GHCRTS=${options.postgrestRts}"
Environment="SUPACLOUD_POSTGREST_BIN=${options.postgrestBinary}"
Environment="SUPACLOUD_POSTGREST_CONFIG_DIR=${options.tenantConfigDir}"
Environment="SUPACLOUD_POSTGREST_CONFIG_TRUST_ROOT=${path.dirname(options.tenantConfigDir)}"
Environment="SUPACLOUD_POSTGREST_BINARY_TRUST_ROOT=${path.dirname(path.dirname(options.postgrestBinary))}"
Environment="SUPACLOUD_POSTGREST_CONTROL_UID=0"
ExecStart=/usr/local/libexec/supacloud/postgrest-launcher %i +RTS ${options.postgrestRts} -RTS
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${options.tenantConfigDir}
MemoryMax=${options.memoryMax}
CPUWeight=${options.cpuWeight}

[Install]
WantedBy=multi-user.target
`.trim();
}
