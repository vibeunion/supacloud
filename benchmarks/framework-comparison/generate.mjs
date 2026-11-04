import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderApplication } from "../../packages/compiler/dist/index.js";

// I have nothing but my burger and I want nothing more
// Use the release compiler to emit invokers, rather than hand-tuning benchmark handlers.
const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, "generated");
const { applicationCode } = renderApplication({
  externalTokens: [],
  modules: [{
    name: "framework-comparison", className: "BenchmarkModule", file: "controller.ts", line: 1,
    imports: [], providers: [], commands: [], queries: [], exports: [],
    controllers: [{
      className: "BenchmarkController", path: "", scope: "application", deps: [],
      file: "controller.ts", importPath: "controller", schemaImports: { Params: "controller", Body: "controller" },
      routes: [
        { method: "GET", path: "/json", handler: "json" },
        { method: "GET", path: "/params/:id", handler: "params", params: "Params",
          pathParams: ["id"], paramBindings: ["id"], handlerParams: [{ kind: "param", name: "id" }] },
        { method: "POST", path: "/echo", handler: "echo", body: "Body", handlerParams: [{ kind: "body", name: "body" }] },
      ],
    }],
  }],
}, { rootDir: root, outDir });
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "application.ts"), applicationCode);
