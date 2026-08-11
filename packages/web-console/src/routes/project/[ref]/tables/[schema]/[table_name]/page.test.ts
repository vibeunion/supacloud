import { describe, expect, test } from "bun:test";

const pageSource = await Bun.file(new URL("./+page.svelte", import.meta.url)).text();

describe("dynamic table rows page", () => {
  test("registers the loaded resource in a nested scoped admin context", () => {
    expect(pageSource).toContain("captureAdminContext()");
    expect(pageSource).toContain("provideAdminContext({");
    expect(pageSource).toContain("get providerBundle()");
    expect(pageSource).toContain("get resources()");
    expect(pageSource).toContain("get tenant()");
    expect(pageSource).not.toContain("setResources");
    expect(pageSource).not.toContain("<AdminApp");
  });

  test("removes stale rows while columns load and aborts superseded requests", () => {
    expect(pageSource).toContain("tableResource = undefined;");
    expect(pageSource).toContain("const controller = new AbortController();");
    expect(pageSource).toContain("cancelled = true;");
    expect(pageSource).toContain("controller.abort();");
    expect(pageSource).toContain("tableResource?.name === currentResourceName");
  });

  test("keeps synthetic row identities on the read-only display path", () => {
    expect(pageSource).toContain("selectable={false}");
    expect(pageSource).toContain("parseTableColumnsResponse(payload)");
    expect(pageSource).toContain('resolve("/project/[ref]/tables"');
    expect(pageSource).not.toContain("value: any");
  });
});
