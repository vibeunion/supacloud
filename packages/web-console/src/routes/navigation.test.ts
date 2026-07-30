import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

const rootLayoutSource = read("./+layout.svelte");
const sidebarSource = read("../lib/components/Sidebar.svelte");
const platformSidebarSource = read("../lib/components/PlatformSidebar.svelte");
const platformLayoutSource = read("./platform/+layout.svelte");
const databaseLayoutSource = read("./project/[ref]/database/+layout.svelte");
const authLayoutSource = read("./project/[ref]/auth/+layout.svelte");

describe("console navigation information architecture", () => {
  test("groups project data tools and exposes one monitoring entry", () => {
    expect(sidebarSource).toContain('titleKey: "Navigation.database_objects"');
    expect(sidebarSource).toContain('titleKey: "Navigation.cache"');
    expect(sidebarSource).toContain('titleKey: "Navigation.reports"');
    expect(sidebarSource).toContain('href: `/project/${projectRef}/reports`');
    expect(sidebarSource).not.toContain("reports/query-performance");
    expect(sidebarSource).not.toContain("reports/database-linter");
    expect(sidebarSource).not.toContain("reports/diagnostics");
    expect(sidebarSource).not.toContain("reports/advisors");
  });

  test("keeps API connection and mobile navigation in the global project header", () => {
    expect(rootLayoutSource).toContain('Navigation.connect_api');
    expect(rootLayoutSource).toContain('id="mobile-navigation"');
    expect(rootLayoutSource).toContain('className="hidden lg:flex"');
    expect(rootLayoutSource).toContain('aria-controls="mobile-navigation"');
    expect(rootLayoutSource).toContain('role="dialog"');
    expect(rootLayoutSource).toContain("mobileNavCloseButton?.focus()");
    expect(rootLayoutSource).toContain('event.key !== "Tab"');
    expect(rootLayoutSource).toContain("handleMobileNavigation");
  });

  test("uses one grouped platform navigation instead of duplicate top tabs", () => {
    expect(platformSidebarSource).toContain("Platform.performance_runtime");
    expect(platformSidebarSource).toContain("Platform.operations");
    expect(platformSidebarSource).toContain('href="/platform/settings"');
    expect(platformLayoutSource).not.toContain("const TABS");
    expect(platformLayoutSource).not.toContain("/platform/${tab.id}");
  });

  test("groups dense database and auth secondary navigation", () => {
    expect(databaseLayoutSource).toContain("DatabaseNav.build");
    expect(databaseLayoutSource).toContain("DatabaseNav.access");
    expect(databaseLayoutSource).toContain("DatabaseNav.data_flow");
    expect(databaseLayoutSource).toContain("DatabaseNav.operations");
    expect(authLayoutSource).toContain("AuthNav.sign_in");
    expect(authLayoutSource).toContain("AuthNav.security");
    expect(authLayoutSource).toContain("AuthNav.messaging");
    expect(databaseLayoutSource).toContain('name="database-navigation"');
    expect(authLayoutSource).toContain('aria-haspopup="menu"');
    expect(authLayoutSource).toContain('aria-expanded={openMenu === group.labelKey}');
    expect(databaseLayoutSource).toContain("closeMenusOnOutsideClick");
    expect(authLayoutSource).toContain("closeMenusOnOutsideClick");
    expect(databaseLayoutSource).toContain("closeMenuFromLink");
    expect(authLayoutSource).toContain("closeMenuFromLink");
    expect(authLayoutSource).toContain("closeMenuOnEscape");
    expect(authLayoutSource).toContain("AuthNav.tabs.providers");
    expect(authLayoutSource).not.toContain('name: "提供者"');
  });

  test("keeps Templates, SMTP, and Hooks linked to their routes and closes their menu", () => {
    expect(authLayoutSource).toContain('path: "templates"');
    expect(authLayoutSource).toContain('path: "smtp"');
    expect(authLayoutSource).toContain('path: "hooks"');
    expect(authLayoutSource).toContain("resolve(tab.route, { ref: projectRef })");
    expect(authLayoutSource).toContain("onclick={closeMenuFromLink}");
  });

  test("keeps every grouped database navigation target reachable", () => {
    const routeIds = [
      "schemas",
      "types",
      "functions",
      "triggers",
      "materialized-views",
      "roles",
      "column-privileges",
      "rls-tester",
      "temporary-access",
      "indexes",
      "extensions",
      "publications",
      "hooks",
      "pipelines",
      "wrappers",
      "cron",
      "migrations",
      "backups",
      "upgrade",
      "settings",
    ];

    for (const routeId of routeIds) {
      expect(existsSync(new URL(`./project/[ref]/database/${routeId}/+page.svelte`, import.meta.url))).toBe(true);
    }
  });
});
