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
    expect(loginPageSource).toContain('const CONSOLE_LANDING_PATH = "/projects";');
    expect(loginPageSource).toContain("window.location.replace(CONSOLE_LANDING_PATH)");
    expect(loginPageSource).toContain("window.location.href = CONSOLE_LANDING_PATH");
    expect(loginPageSource).not.toContain('window.location.replace("/")');
    expect(loginPageSource).not.toContain('window.location.href = "/"');
  });

  test("logout redirects only after the backend confirms success", () => {
    expect(layoutSource).toContain("const result = await logoutStudio();");
    expect(layoutSource).toContain("if (!result.success)");
    expect(layoutSource).toContain("toast.error(result.error);");
    expect(layoutSource).not.toContain("await logoutStudio();\n    } finally {");
  });

  test("provides one reactive scoped admin context without module-level provider mirrors", () => {
    expect(layoutSource).toContain("createProviderBundle");
    expect(layoutSource).toContain("provideAdminContext");
    expect(layoutSource).toContain("get providerBundle()");
    expect(layoutSource).toContain("get resources()");
    expect(layoutSource).toContain("get tenant()");
    expect(layoutSource).toContain("resolveAdminTenant");
    expect(layoutSource).not.toContain("setDataProvider");
    expect(layoutSource).not.toContain("setAuthProvider");
    expect(layoutSource).not.toContain("setRouterProvider");
    expect(layoutSource).not.toContain("setChatProvider");
    expect(layoutSource).not.toContain("setResources");
    expect(layoutSource).not.toContain("setComponentRegistry");
  });

  test("keeps one SvAdmin toast host and never falls back an unknown project route", () => {
    expect(layoutSource.match(/<SvadminToast/g)).toHaveLength(1);
    expect(layoutSource).not.toContain("<Toaster");
    expect(layoutSource).not.toContain("projects.find(p => p.ref === refFromUrl) || projects[0]");
    expect(layoutSource).toContain("projects.find((project) => project.ref === refFromUrl) ?? null");
  });
});
