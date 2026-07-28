import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("auth URL configuration page", () => {
  test("sends canonical auth URL keys and displays SITE_URL validation errors", () => {
    expect(pageSource).toContain("site_url: siteUrl");
    expect(pageSource).toContain("uri_allow_list: redirectUrls.join");
    expect(pageSource).toContain("siteUrlError");
  });
});
