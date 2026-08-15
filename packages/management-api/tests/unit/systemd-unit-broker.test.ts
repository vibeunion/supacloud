import { describe, expect, test } from "bun:test";
import { assertManagedSystemdUnitContent } from "../../src/services/systemd-unit-broker";
import { renderPostgrestSystemdTemplate } from "../../src/services/postgrest-systemd-template";

function frontendUnit(user = "supacloud-demo", extra = ""): string {
  return `[Unit]
Description=test
[Service]
Type=simple
User=${user}
Group=${user}
NoNewPrivileges=true
EnvironmentFile=/var/supacloud/frontends/demo/abc123ff/.env
${extra}ExecStart=/bin/true
[Install]
WantedBy=multi-user.target
`;
}

function postgrestUnit(extra = ""): string {
  return `[Unit]
Description=test
[Service]
Type=simple
User=supacloud-%i
Group=supacloud-%i
NoNewPrivileges=true
${extra}ExecStart=/usr/local/libexec/supacloud/postgrest-launcher %i
[Install]
WantedBy=multi-user.target
`;
}

function canonicalPostgrestUnit(): string {
  return renderPostgrestSystemdTemplate({
    postgrestRts: "-N2 -A8m",
    postgrestBinary: "/opt/supacloud/postgrest-v16.1/bin/postgrest",
    tenantConfigDir: "/etc/supabase/tenants",
    memoryMax: "64M",
    cpuWeight: 20,
  });
}

describe("systemd unit broker policy", () => {
  test("accepts the launcher-based PostgREST unit without an environment file", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-pgrst@.service",
      canonicalPostgrestUnit(),
    )).not.toThrow();
  });

  test("allows only an approved optional PostgREST environment file", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-pgrst@.service",
      postgrestUnit("EnvironmentFile=/etc/supabase/tenants/%i.env\n"),
    )).not.toThrow();
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-pgrst@.service",
      postgrestUnit("EnvironmentFile=-/etc/supabase/management-api.env\n"),
    )).toThrow(/invalid EnvironmentFile/);
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-pgrst@.service",
      postgrestUnit(
        "EnvironmentFile=/etc/supabase/tenants/%i.env\nEnvironmentFile=/etc/supabase/tenants/%i.env\n",
      ),
    )).toThrow(/invalid EnvironmentFile/);
  });

  test("accepts a non-root frontend unit matching its tenant", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123ff.service",
      frontendUnit(),
    )).not.toThrow();
  });

  test("rejects root identities and privileged directive injection", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123ff.service",
      frontendUnit("root"),
    )).toThrow(/invalid User/);
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123ff.service",
      frontendUnit("supacloud-demo", "ExecStartPre=/bin/sh\n"),
    )).toThrow(/unsupported directive/);
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123ff.service",
      frontendUnit().replace("ExecStart=/bin/true", "ExecStart=+/bin/true"),
    )).toThrow(/privileged execution prefix/);
  });

  test("rejects a frontend unit whose tenant identity does not match its name", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-other-abc123ff.service",
      frontendUnit(),
    )).toThrow(/invalid EnvironmentFile/);
  });

  test("rejects control-plane environment files and control characters", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123ff.service",
      frontendUnit().replace(
        "/var/supacloud/frontends/demo/abc123ff/.env",
        "-/etc/supabase/management-api.env",
      ),
    )).toThrow(/invalid EnvironmentFile/);
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123ff.service",
      frontendUnit().replace("Description=test", "Description=test\u0001injected"),
    )).toThrow(/invalid content/);
  });

  test("continues to require an environment file for frontend units", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123ff.service",
      frontendUnit().replace("EnvironmentFile=/var/supacloud/frontends/demo/abc123ff/.env\n", ""),
    )).toThrow(/missing its non-root runtime identity/);
  });

  test("continues to require an environment file for GoTrue units", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-gotrue@.service",
      postgrestUnit().replace(
        "ExecStart=/usr/local/libexec/supacloud/postgrest-launcher %i",
        "ExecStart=/usr/local/bin/gotrue",
      ),
    )).toThrow(/missing its non-root runtime identity/);
  });
});
