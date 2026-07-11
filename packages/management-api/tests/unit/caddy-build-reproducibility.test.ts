import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const builder = readFileSync(
  new URL("../../../../scripts/build_supacloud_caddy.sh", import.meta.url),
  "utf8",
);

describe("Caddy release build reproducibility", () => {
  test("pins the rate-limit plugin to an immutable upstream commit", () => {
    expect(builder).toContain("5625512f24f6f59d6f64fb3aafe5eecff0b286db");
    expect(builder).toContain("github.com/mholt/caddy-ratelimit@");
    expect(builder).not.toContain(
      'RATE_LIMIT_MODULE="${RATE_LIMIT_MODULE:-github.com/mholt/caddy-ratelimit}"',
    );
  });
});
