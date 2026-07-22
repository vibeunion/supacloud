import { describe, expect, test } from "bun:test";
import { assertManagedSystemdUnitContent } from "../../src/services/systemd-unit-broker";

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

describe("systemd unit broker policy", () => {
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
});
