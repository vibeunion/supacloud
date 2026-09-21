import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Flow } from "@pgflow/dsl";

export async function loadFlow(path: string) {
    if (!isAbsolute(path)) throw new Error("Flow module path must be absolute");
    const module: unknown = await import(pathToFileURL(path).href);
    if (typeof module !== "object" || module === null || !("default" in module) || !(module.default instanceof Flow)) {
        throw new Error("Flow module must default-export a pgflow Flow");
    }
    return module.default;
}
