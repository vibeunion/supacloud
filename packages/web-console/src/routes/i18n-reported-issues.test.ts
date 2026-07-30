import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const en = JSON.parse(readFileSync(new URL("../lib/i18n/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(readFileSync(new URL("../lib/i18n/locales/zh.json", import.meta.url), "utf8"));
const authPages = [
  "custom-providers",
  "mfa",
  "oauth-server",
  "passkeys",
  "policies",
  "protection",
  "rate-limits",
  "sessions",
];
const reportPages = ["api-overview", "auth", "database", "query-performance", "storage"];
const rootDashboardSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
const platformMonitoringSource = readFileSync(
  new URL("platform/monitoring/+page.svelte", import.meta.url),
  "utf8",
);
const hanCharacters = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function leafKeys(value: unknown, path = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => leafKeys(child, path ? `${path}.${key}` : key));
  }
  return [path];
}

function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("reported-issues i18n contract", () => {
  test("keeps English and Chinese locale leaf keys in parity", () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(zh).sort());
  });

  test("keeps Chinese copy out of the English locale", () => {
    expect(JSON.stringify(en)).not.toMatch(hanCharacters);
    expect(JSON.stringify(zh)).toMatch(hanCharacters);
  });

  test("uses a product-facing cache data-plane title", () => {
    expect(en.Cache.platform_title).toBe("Cache Data Plane");
    expect(zh.Cache.platform_title).toBe("缓存数据面");
  });

  test("keeps reported Auth pages free of hardcoded CJK copy", () => {
    for (const page of authPages) {
      const source = readFileSync(new URL(`project/[ref]/auth/${page}/+page.svelte`, import.meta.url), "utf8");
      expect(withoutComments(source)).not.toMatch(hanCharacters);
    }
  });

  test("keeps reported monitoring pages free of hardcoded CJK copy", () => {
    for (const page of reportPages) {
      const source = readFileSync(new URL(`project/[ref]/reports/${page}/+page.svelte`, import.meta.url), "utf8");
      expect(withoutComments(source)).not.toMatch(hanCharacters);
    }
  });

  test("keeps the root dashboard free of hardcoded CJK copy", () => {
    expect(withoutComments(rootDashboardSource)).not.toMatch(hanCharacters);
  });

  test("keeps Grafana monitoring error states localized and visible", () => {
    expect(withoutComments(platformMonitoringSource)).not.toMatch(hanCharacters);
    expect(platformMonitoringSource).toContain("onerror={handleGrafanaFrameError}");
    expect(platformMonitoringSource).toContain("dashboard_load_failed_desc");
    expect(en.PlatformMonitoring.dashboard_load_failed).toBeTruthy();
    expect(zh.PlatformMonitoring.dashboard_load_failed).toBeTruthy();
  });

  test("localizes task-center status labels while preserving technical values", () => {
    const source = readFileSync(new URL("project/[ref]/tasks/+page.svelte", import.meta.url), "utf8");

    expect(withoutComments(source)).not.toMatch(hanCharacters);
    expect(source).toContain("taskStatusLabel(task.status)");
    expect(source).toContain("title={task.status}");
    expect(source).not.toContain(">{task.status}<");
    expect(zh.TaskCenter.dead_letter_queue).toContain("死信队列");
    expect(en.TaskCenter.max_payload).toContain("Payload");
  });
});
