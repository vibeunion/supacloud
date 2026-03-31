// Bun Plugin: URL Import Interception
// Maps Deno URL imports (deno.land, esm.sh, skypack) to local shims or npm packages
import { plugin } from "bun";

// Deno std library → local shim / node built-in mapping
const DENO_STD_MAP: Record<string, string> = {
  // HTTP
  "http/server.ts": "./shims/deno-http-server.ts",
  "http/server_legacy.ts": "./shims/deno-http-server.ts",

  // Encoding
  "encoding/base64.ts": "./shims/deno-encoding.ts",
  "encoding/base64url.ts": "./shims/deno-encoding.ts",
  "encoding/hex.ts": "./shims/deno-encoding.ts",

  // Path
  "path/mod.ts": "node:path",
  "path/posix.ts": "node:path/posix",
  "path/win32.ts": "node:path/win32",

  // Crypto
  "crypto/mod.ts": "./shims/deno-crypto.ts",

  // Streams
  "streams/mod.ts": "node:stream/web",

  // Assert (testing)
  "assert/mod.ts": "node:assert",
  "testing/asserts.ts": "node:assert",
};

plugin({
  name: "deno-url-imports",
  setup(build) {
    // Intercept https://deno.land/std@xxx/...
    build.onResolve(
      { filter: /^https:\/\/deno\.land\/std/ },
      (args) => {
        const match = args.path.match(/std@[\d.]+\/(.+)$/);
        if (match) {
          const mapped = DENO_STD_MAP[match[1]];
          if (mapped) {
            if (mapped.startsWith("node:")) {
              return { path: mapped, external: true };
            }
            return { path: require.resolve(mapped) };
          }
        }
        console.warn(
          `[URL Import] Unmapped deno.land import: ${args.path}`,
        );
        return { path: args.path, external: true };
      },
    );

    // Intercept https://esm.sh/xxx → npm package name
    build.onResolve({ filter: /^https:\/\/esm\.sh\// }, (args) => {
      const cleaned = args.path
        .replace("https://esm.sh/", "")
        .replace(/^v\d+\//, ""); // strip version prefix v135/
      let pkg = cleaned;
      if (pkg.startsWith("@")) {
        const parts = pkg.split("@");
        pkg = "@" + parts[1];
      } else {
        pkg = pkg.split("@")[0];
      }
      return { path: pkg, external: true }; // resolve via node_modules
    });

    // Intercept https://cdn.skypack.dev/ → npm package name
    build.onResolve(
      { filter: /^https:\/\/cdn\.skypack\.dev\// },
      (args) => {
        const pkg = args.path
          .replace("https://cdn.skypack.dev/", "")
          .split("@")[0];
        return { path: pkg, external: true };
      },
    );
  },
});

console.log("[URL Import Plugin] Deno URL import interception registered");
