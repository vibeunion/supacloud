import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..", "..");

describe("Realtime systemd deployment", () => {
  test("global Realtime unit does not sandbox podman syscalls", () => {
    const unit = readFileSync(
      join(repoRoot, "infrastructure/systemd/supacloud-realtime.service"),
      "utf8",
    );

    expect(unit).toContain("SupaCloud Realtime Service");
    expect(unit).toContain("podman run");
    expect(unit).not.toContain("SystemCallFilter=");
  });

  test("installer pre-pulls and tags the Realtime image before systemd restart", () => {
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    const realtimeSection = installer.slice(
      installer.indexOf("# --- 2. Deploy Supabase Realtime"),
      installer.indexOf("# --- 3. Update management API env"),
    );

    expect(realtimeSection).toContain("REALTIME_IMAGE_PULL");
    expect(realtimeSection).toContain("$RUNTIME pull \"$REALTIME_IMAGE_PULL\"");
    expect(realtimeSection).toContain("$RUNTIME tag \"$REALTIME_IMAGE_PULL\" \"$REALTIME_IMAGE_VALUE\"");
    expect(realtimeSection.indexOf("$RUNTIME pull")).toBeLessThan(
      realtimeSection.indexOf("systemctl restart supacloud-realtime"),
    );
  });
});
