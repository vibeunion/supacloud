import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const layoutSource = readFileSync(new URL("./+layout.svelte", import.meta.url), "utf8");
const loginPageSource = readFileSync(new URL("./login/+page.svelte", import.meta.url), "utf8");

describe("root layout source guards", () => {
  test("i18n loading is guarded so it cannot block the app forever", () => {
    expect(layoutSource).toContain("let i18nLoadGuardExpired = $state(false);");
    expect(layoutSource).toContain("projectsLoading || ($isLoading && !i18nLoadGuardExpired)");
    expect(layoutSource).toContain("i18nLoadGuardExpired = true;");
    expect(layoutSource).toContain("clearTimeout(guardTimer);");
  });

  test("authenticated visitors leave the login page without submitting credentials", () => {
    expect(loginPageSource).toContain('import { onMount } from "svelte";');
    expect(loginPageSource).toContain("getStudioSession");
    expect(loginPageSource).toContain("session.authenticated");
    expect(loginPageSource).toContain('window.location.replace("/")');
  });
});
