import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("./+layout.svelte", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./[id]/+page.svelte", import.meta.url), "utf8");

describe("hosting deployment entrypoints", () => {
  test("shows only the empty-state action when no deployments exist", () => {
    expect(pageSource).toContain("{#if deployments.length > 0}");
    expect(pageSource).toContain('{$t("Hosting.no_deployments")}');
    expect(layoutSource).not.toContain('{ id: "new"');
  });

  test("exposes the existing ZIP deployment endpoint in site settings", () => {
    expect(settingsSource).toContain('id="zip-upload"');
    expect(settingsSource).toContain('accept=".zip,application/zip"');
    expect(settingsSource).toContain("/deployments/${deployId}/deploy/upload");
    expect(settingsSource).toContain("new FormData()");
    expect(settingsSource).toContain('uploadBody.append("file", file)');
    expect(settingsSource).toContain("timeoutMs: FRONTEND_DEPLOY_TIMEOUT_MS");
    expect(settingsSource).not.toContain('headers: { "Content-Type": "application/zip" }');
    expect(settingsSource).toContain('keys().data.list(`v1/projects/${projectRef}/frontend/deployments`)');
  });

  test("localizes the Pages header and preserves the Webhook endpoint", () => {
    expect(layoutSource).toContain('$t("Hosting.pages_title")');
    expect(layoutSource).toContain('$t("Hosting.pages_tagline")');
    expect(pageSource).toContain('$t("Hosting.webhook_trigger")');
    expect(pageSource).toContain('/v1/webhooks/{github|gitlab|gitee|gitcode}');
  });

  test("reports backend deployment deletion failures without showing false success", () => {
    expect(pageSource).toContain('import { apiClient, ensureMutationSucceeded } from "$lib/api";');
    expect(pageSource).toContain('await ensureMutationSucceeded(response, "删除部署失败");');
    expect(pageSource).toContain("onError: (error: unknown) => {");
    expect(pageSource).toContain("error instanceof Error ? error.message : String(error)");
  });

  test("checks domain and token deletion responses in deployment settings", () => {
    expect(settingsSource).toContain('await ensureMutationSucceeded(response, "删除域名失败");');
    expect(settingsSource).toContain('await ensureMutationSucceeded(response, "删除访问令牌失败");');
    expect(settingsSource.match(/onError: \(error: unknown\)/g) ?? []).toHaveLength(2);
  });
});
