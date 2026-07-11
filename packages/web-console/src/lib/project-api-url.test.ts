import { describe, expect, test } from "bun:test";

import { getProjectApiUrl } from "./project-api-url";

describe("getProjectApiUrl", () => {
  test("uses the backend canonical API URL including HTTPS and custom domains", () => {
    expect(getProjectApiUrl({
      api: { url: "https://api.customer.example/" },
      endpoint: "http://localhost:8000",
    })).toBe("https://api.customer.example");
  });

  test("falls back to the backend endpoint and rejects unsafe or missing values", () => {
    expect(getProjectApiUrl({ endpoint: "http://tenant.api.localhost" })).toBe("http://tenant.api.localhost");
    expect(getProjectApiUrl({ api: { url: "javascript:alert(1)" } })).toBe("");
    expect(getProjectApiUrl(null)).toBe("");
  });
});
