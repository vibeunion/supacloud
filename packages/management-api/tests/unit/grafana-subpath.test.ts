import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGrafanaSubpathConfig,
  captureGrafanaConfigSnapshots,
  renderGrafanaSubpathConfig,
  restoreGrafanaConfig,
} from "../../src/grafana-subpath";

describe("Grafana subpath configuration", () => {
  test("replaces the active root URL and adds subpath serving inside [server]", () => {
    const source = [
      "[server]",
      "root_url = /ui/",
      "domain = localhost",
      "",
      "[database]",
      "type = sqlite3",
      "",
    ].join("\n");

    expect(renderGrafanaSubpathConfig(source)).toBe([
      "[server]",
      "root_url = /grafana/",
      "domain = localhost",
      "serve_from_sub_path = true",
      "",
      "[database]",
      "type = sqlite3",
      "",
    ].join("\n"));
  });

  test("preserves commented defaults and updates existing active settings", () => {
    const source = "[server]\r\n;root_url = %(protocol)s://%(domain)s/\r\nserve_from_sub_path = false\r\n";
    expect(renderGrafanaSubpathConfig(source)).toBe(
      "[server]\r\n;root_url = %(protocol)s://%(domain)s/\r\nserve_from_sub_path = true\r\nroot_url = /grafana/\r\n",
    );
  });

  test("preserves an already-correct absolute Grafana root URL", () => {
    const source = "[server]\nroot_url = https://studio.example.com/grafana/\nserve_from_sub_path = true\n";
    expect(renderGrafanaSubpathConfig(source)).toBe(source);
  });

  test("rejects ambiguous or structurally invalid server configuration", () => {
    expect(() => renderGrafanaSubpathConfig("[server]\nroot_url = /one\nroot_url = /two\n"))
      .toThrow("duplicate root_url");
    expect(() => renderGrafanaSubpathConfig("[database]\ntype = sqlite3\n"))
      .toThrow("does not contain a [server] section");
  });

  test("updates and restores direct files without changing permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-grafana-config-"));
    const configPath = join(directory, "grafana.ini");
    const original = "[server]\nroot_url = /ui/\n";
    try {
      writeFileSync(configPath, original);
      chmodSync(configPath, 0o640);
      const snapshots = captureGrafanaConfigSnapshots([configPath]);

      expect(applyGrafanaSubpathConfig(snapshots)).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain("root_url = /grafana/");
      expect(lstatSync(configPath).mode & 0o777).toBe(0o640);

      restoreGrafanaConfig(snapshots[0]!);
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(lstatSync(configPath).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects symlinked configuration targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-grafana-link-"));
    const targetPath = join(directory, "target.ini");
    const linkedPath = join(directory, "grafana.ini");
    try {
      writeFileSync(targetPath, "[server]\nroot_url = /ui/\n");
      symlinkSync(targetPath, linkedPath);
      expect(() => captureGrafanaConfigSnapshots([linkedPath])).toThrow("direct regular file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
