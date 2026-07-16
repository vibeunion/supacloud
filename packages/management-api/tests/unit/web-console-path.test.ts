import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWebConsoleDir,
} from "../../src/utils/web-console-path";

describe("web console runtime path resolution", () => {
  test("uses WEB_CONSOLE_DIR only when index.html exists", () => {
    const root = mkdtempSync(join(tmpdir(), "supacloud-web-console-path-"));
    const configuredDir = join(root, "configured");
    const currentDir = join(root, "current");
    const legacyDir = join(root, "legacy");

    mkdirSync(configuredDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });

    writeFileSync(join(currentDir, "index.html"), "<html/>\n");
    writeFileSync(join(legacyDir, "index.html"), "<html/>\n");

    try {
      expect(
        resolveWebConsoleDir({
          env: { WEB_CONSOLE_DIR: configuredDir },
          currentDir,
          legacyDir,
        }),
      ).toBe(currentDir);
      writeFileSync(join(configuredDir, "index.html"), "<html/>\n");
      expect(
        resolveWebConsoleDir({
          env: { WEB_CONSOLE_DIR: configuredDir },
          currentDir,
          legacyDir,
        }),
      ).toBe(configuredDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to current then legacy if configured path is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "supacloud-web-console-path-"));
    const currentDir = join(root, "current");
    const legacyDir = join(root, "legacy");

    mkdirSync(currentDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });

    writeFileSync(join(currentDir, "index.html"), "<html/>\n");

    try {
      expect(
        resolveWebConsoleDir({
          env: { WEB_CONSOLE_DIR: join(root, "missing") },
          currentDir,
          legacyDir,
        }),
      ).toBe(currentDir);

      writeFileSync(join(legacyDir, "index.html"), "<html/>\n");
      rmSync(join(currentDir, "index.html"));

      expect(
        resolveWebConsoleDir({
          env: { WEB_CONSOLE_DIR: join(root, "missing") },
          currentDir,
          legacyDir,
        }),
      ).toBe(legacyDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
