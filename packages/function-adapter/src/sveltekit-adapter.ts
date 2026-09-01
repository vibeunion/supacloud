import { existsSync, readdirSync, writeFileSync } from "node:fs";
import type { Adapter, Builder, RouteDefinition } from "@sveltejs/kit";

export type SupaCloudSvelteKitAdapterOptions = {
  out?: string;
};

function routeList(routes: RouteDefinition[]): string {
  return routes.map((route) => `  - ${route.id}`).join("\n");
}

function directoryHasEntries(directory: string): boolean {
  return existsSync(directory) && readdirSync(directory).length > 0;
}

/** Build an API-only SvelteKit app as a SupaCloud Fetch Function bundle. */
export default function adapter(
  options: SupaCloudSvelteKitAdapterOptions = {},
): Adapter {
  const out = options.out ?? "build";
  return {
    name: "@supacloud/function-adapter/sveltekit-adapter",
    adapt(builder: Builder) {
      const pageRoutes = builder.routes.filter((route) => route.page.methods.length > 0);
      if (pageRoutes.length > 0) {
        throw new Error(
          `sveltekit-function supports API routes only. Deploy page routes with framework=sveltekit:\n${routeList(pageRoutes)}`,
        );
      }
      if (builder.prerendered.paths.length > 0) {
        throw new Error("sveltekit-function does not serve prerendered or static output");
      }
      if (directoryHasEntries(builder.config.kit.files.assets)) {
        throw new Error(
          "sveltekit-function does not serve static assets; deploy the application with SvelteKit Hosting",
        );
      }
      const serverAssets = builder.findServerAssets(builder.routes);
      if (serverAssets.length > 0) {
        throw new Error(
          "sveltekit-function does not support server asset reads; deploy the application with SvelteKit Hosting",
        );
      }

      builder.rimraf(out);
      builder.mkdirp(out);
      builder.writeServer(`${out}/server`);
      writeFileSync(
        `${out}/manifest.js`,
        `export const manifest = ${builder.generateManifest({ relativePath: "./server" })};\n`,
      );
      writeFileSync(
        `${out}/index.js`,
        `import { Server } from "./server/index.js";
import { manifest } from "./manifest.js";

const server = new Server(manifest);
let initialized;

async function fetch(request) {
  initialized ??= server.init({
    env: typeof Deno !== "undefined" && Deno.env?.toObject ? Deno.env.toObject() : {},
  });
  await initialized;
  return server.respond(request, {
    getClientAddress: () => request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || "0.0.0.0",
  });
}

export default {
  fetch,
  __supacloud: { framework: "sveltekit-function", routeAware: true },
};
`,
      );
      builder.log(`Wrote API-only SupaCloud Function bundle to "${out}"`);
    },
    supports: {
      read: () => false,
      instrumentation: () => false,
    },
  };
}
