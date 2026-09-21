import { expect, test } from "bun:test";
import { loadHostingList, parseHostingList } from "./hosting-list";
import { hostingDeployment } from "./hosting-list.test-fixtures";

test("hosting lists preserve validated fields without promoting secrets or arbitrary metadata", () => {
  const row = hostingDeployment();
  expect(parseHostingList({ deployments: [{
    ...row, env_vars: { TOKEN: "private" }, deploy_tokens: [{ token: "private" }], build_log: "private",
  }] }, "a")).toEqual([row]);
  expect(parseHostingList({ deployments: [] }, "a")).toEqual([]);
  expect(parseHostingList({ deployments: [{ ...row, git_url: "", git_branch: "" }] }, "a"))
    .toEqual([{ ...row, git_url: "", git_branch: "" }]);
});

test("hosting lists reject absent, malformed, cross-project and duplicate resources", () => {
  const row = hostingDeployment();
  for (const payload of [null, [], {}, { deployments: null }, { deployments: [row, row] },
    { deployments: [{ ...row, project_ref: "b" }] }, { deployments: [null] },
    ...[
      { id: "" }, { id: "../other" }, { name: "" }, { framework: "unknown" }, { status: "deleted" },
      { created_at: "2026-02-30T00:00:00.000Z" }, { last_deployed_at: null },
      { custom_domains: [null] }, { custom_domains: ["example.com", "EXAMPLE.COM"] },
      { domain: "site.example.com/path" }, { deployment_url: "javascript:alert(1)" },
      { deployment_url: "https://secret:password@site.example.com" }, { deployment_url: "//site.example.com" },
      { git_url: {} },
    ].map(change => ({ deployments: [{ ...row, ...change }] }))]) {
    expect(() => parseHostingList(payload, "a")).toThrow("Invalid hosting list response");
  }
});

test("all supported frameworks and build states remain valid", () => {
  for (const framework of ["static", "react", "vue", "svelte", "nextjs", "nuxt", "sveltekit", "sveltekit-static", "astro", "remix"]) {
    for (const status of ["pending", "building", "success", "failed"]) {
      expect(parseHostingList({ deployments: [{ ...hostingDeployment(), framework, status }] }, "a")[0])
        .toMatchObject({ framework, status });
    }
  }
});

test("hosting reads reject invalid scope before transport and never turn failures into empty lists", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({ deployments: [] }, { status: 500 }); };
  await expect(loadHostingList("../a", request, new AbortController().signal)).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(loadHostingList("a", request, new AbortController().signal)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("hosting reads bind their URL, response identity and body budget", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await expect(loadHostingList("a", async (url, options) => {
    calls.push(url);
    expect(options.redirect).toBe("error");
    return Response.json({ deployments: [hostingDeployment("b")] });
  }, controller.signal)).rejects.toThrow("Invalid hosting list response");
  expect(calls).toEqual(["/v1/projects/a/frontend/deployments"]);
  await expect(loadHostingList("a", async () => new Response("{}", {
    headers: { "content-length": String(8 * 1024 * 1024 + 1) },
  }), controller.signal)).rejects.toThrow("Invalid JSON response");
});
