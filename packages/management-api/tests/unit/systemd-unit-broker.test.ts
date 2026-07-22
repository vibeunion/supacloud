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
${extra}ExecStart=/bin/true
[Install]
WantedBy=multi-user.target
`;
}

describe("systemd unit broker policy", () => {
  test("accepts a non-root frontend unit matching its tenant", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123.service",
      frontendUnit(),
    )).not.toThrow();
  });

  test("rejects root identities and privileged directive injection", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123.service",
      frontendUnit("root"),
    )).toThrow(/invalid User/);
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-demo-abc123.service",
      frontendUnit("supacloud-demo", "ExecStartPre=/bin/sh\n"),
    )).toThrow(/unsupported directive/);
  });

  test("rejects a frontend unit whose tenant identity does not match its name", () => {
    expect(() => assertManagedSystemdUnitContent(
      "supacloud-frontend-other-abc123.service",
      frontendUnit(),
    )).toThrow(/does not match/);
  });
});
