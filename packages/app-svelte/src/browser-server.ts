import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./BrowserHarness.svelte", import.meta.url))],
  target: "browser",
  conditions: ["browser"],
  plugins: [{
    name: "svelte-lifecycle-test",
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        return { contents: compile(source, { filename: path, generate: "client" }).js.code, loader: "js" };
      });
    },
  }],
});
if (!bundle.success) throw new Error(`Lifecycle test build failed: ${bundle.logs.join("\n")}`);
const javascript = bundle.outputs[0];
if (!javascript) throw new Error("Missing lifecycle browser bundle");
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/harness.js") return new Response(javascript, { headers: { "content-type": "text/javascript" } });
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <title>SupaCloud lifecycle acceptance</title><h1>Lifecycle acceptance</h1><div id="app"></div>
      <pre id="result">running</pre><script type="module" src="/harness.js"></script></html>`,
    { headers: { "content-type": "text/html" } });
  },
});
console.log(`Lifecycle browser acceptance: ${server.url}`);
