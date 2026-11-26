import path from "node:path";

export type PostgrestSystemdTemplateOptions = {
  postgrestRts: string;
  postgrestBinary: string;
  tenantConfigDir: string;
  memoryMax: string;
  cpuWeight: number;
};

export function renderPostgrestSystemdTemplate(options: PostgrestSystemdTemplateOptions): string {
  // Postrust has no Haskell RTS. MemoryMax is the tenant limit.
  void options.postgrestRts;
  return `
[Unit]
Description=SupaCloud Postrust REST for tenant %i
Documentation=https://github.com/postrust/postrust
After=network.target patroni.service
Wants=patroni.service
StartLimitBurst=3
StartLimitIntervalSec=60

[Service]
Type=simple
User=supacloud-%i
Group=supacloud-%i
Environment="SUPACLOUD_POSTGREST_BIN=${options.postgrestBinary}"
Environment="SUPACLOUD_POSTGREST_CONFIG_DIR=${options.tenantConfigDir}"
Environment="SUPACLOUD_POSTGREST_CONFIG_TRUST_ROOT=${path.dirname(options.tenantConfigDir)}"
Environment="SUPACLOUD_POSTGREST_BINARY_TRUST_ROOT=${path.dirname(path.dirname(options.postgrestBinary))}"
Environment="SUPACLOUD_POSTGREST_CONTROL_UID=0"
ExecStart=/usr/local/libexec/supacloud/postrust-launcher %i
Restart=on-failure
RestartSec=5

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
