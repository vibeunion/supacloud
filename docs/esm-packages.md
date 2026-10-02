# ESM-only package policy

## Decision and compatibility boundary

SupaCloud-owned libraries and executable entrypoints use ESM. The repository
root declares `"type": "module"`; private and unscoped owned packages are
covered by the same metadata guard. Package-scoped
`.js` with `"type": "module"` remains the default; an explicit `.mjs` entry is
also valid. This migration does not rename existing ESM files or change the
public import specifiers.

`@supacloud/app` no longer builds `dist/index.cjs` or advertises a separate
`exports.require` branch. Its root, `/browser`, `/contracts` and `/execution`
entrypoints retain their existing ESM paths and declaration files.
`@supacloud/js` and `@supacloud/compiler` already use this model and are not
rebuilt as CommonJS or renamed as part of this change.

ESM-only is a publication format, not a blanket prohibition on CommonJS:

- `@supacloud/lite` now publishes `dist/launcher.mjs` as its Node-to-Bun **bin**.
  There is no CommonJS launcher exception and no shipped `.cjs` fallback.
  Startup errors, argv, signal forwarding and child exit codes are preserved.
- Edge Runtime's guarded loading of third-party CommonJS dependencies, their
  security checks and CommonJS compatibility fixtures remain unchanged.
- CommonJS wrappers generated inside an ESM bundle are not deleted by textual
  search. This policy does not attempt to rewrite third-party dependency code.

## Public SDK compatibility

The public `@supacloud/js` SDK has a different consumer contract from the
server framework: its root, `/task-events` and `/contracts` explicitly support
both `import` and synchronous `require()` on Node 22.12.0+. Their `module-sync`,
`import` and `default` conditions resolve to the same ESM file, so this adds no
CJS build, duplicated error classes or asynchronous initialization wrapper.

This is not a promise of compatibility with older Node or CJS-only bundlers.
The newly explicit `engines.node` floor is a release compatibility change.
See the [SDK compatibility contract](../packages/supacloud-js/COMPATIBILITY.md)
for browser/TypeScript boundaries and the conditions for adding real CJS output.

## Lite launcher migration

The supported command remains `supacloud-lite`; use the installed executable
rather than hard-coding a `dist` path. Custom scripts using `dist/launcher.cjs`
must switch to `dist/launcher.mjs` or the package executable.

`supacloud-cli lite` now resolves `bin["supacloud-lite"]` from the locally
installed `@supacloud/lite/package.json`, not a hard-coded extension. Explicit
`SUPACLOUD_LITE_CLI_BIN` still has priority. When no local package is installed,
resolution falls back to PATH.
A corrupt manifest, escaping bin path or missing local bin is an error, not a
reason to silently invoke an unrelated global installation. This also permits
an older installed release to run through its own declared bin; it does not
publish or generate a new CommonJS implementation.

Upgrade the Project CLI together with Lite. Older CLI versions hard-code the
old launcher path; use `supacloud-lite` directly while upgrading. This section
supersedes legacy launcher-path examples in the Project CLI README.

## Consumer migration and release

Removing the published CommonJS implementation is a **breaking compatibility
change**, not a patch-level cleanup. The conventional breaking-change commit
and release-please process own the release version; do not silently republish
an existing version or hand-edit generated release records.

Use package-name ESM imports, without changing the established public APIs:

```ts
import { InjectionToken } from '@supacloud/app';
import { HttpClient } from '@supacloud/app/browser';
import { createAuthoritativeCommandClient } from '@supacloud/js/contracts';
```

A CommonJS application can load the ESM implementation asynchronously:

```js
async function start() {
  const { InjectionToken } = await import('@supacloud/app');
  return new InjectionToken('application');
}
```

Synchronous `require('@supacloud/app')` is no longer a supported package
contract. Some Node versions can load eligible synchronous ESM graphs through
`require()`, but consumers must not depend on that behavior. Migrate old direct
`dist/index.cjs` references and tooling that requires a separate CJS build.

The application/compiler baseline remains Node 24 and Bun 1.4.2. SDK loader
acceptance also covers Node 22.12.0 and Node 26. SDK-specific TypeScript
NodeNext checks cover both `.cts` and `.mts` consumers: TypeScript 5.8.3 checks
the full declaration graph; TypeScript 7 checks consumers with skipLibCheck=true
because of a documented upstream auth-js/lib.dom WebAuthn declaration conflict.
The broader app/compiler check retains its ESNext/bundler configuration and
skipLibCheck setting. Neither claims support for all compiler configurations.
The SDK uses a type-only ESM/CommonJS Supabase declaration bridge without
casting callers or erasing their client/database generic type.

## Verification

```sh
npm run test:esm
node .github/scripts/esm-package-policy.mjs
# After the app/Lite builds; also checked by their publication lifecycles:
bun run --cwd packages/app check:package
bun run --cwd packages/supacloud-js check:package
bun run --cwd packages/supacloud-lite check:package
# After building contracts, delivery, app, supacloud-js and compiler:
node .github/scripts/esm-package.acceptance.mjs
```

The metadata guard checks the root and all top-level package manifests,
including private/unscoped packages, nested export conditions, executable bins
and explicit CommonJS build flags. A Git file-inventory guard rejects owned
`.cjs`/`.cts` sources (tracked and non-ignored untracked files), excluding
`node_modules` and compatibility data under `fixtures/`. It does not rewrite
third-party code or ban `createRequire` interoperability inside an ES module.
The pack guard checks the actual npm file inventory for missing export/type/bin
targets and stale `.cjs`, `.cts` or associated source-map artifacts. Unknown
wildcard targets fail explicitly rather than receiving an unearned pass.

`ESM Package Contracts` adds an independent CI workflow with read-only repository
permissions. It builds the five candidate packages, packs real archives,
normalizes sibling dependencies with the existing release helper, and installs
all candidate archives outside the checkout. It verifies every public app,
SDK and compiler entrypoint under Node and Bun, CJS-to-ESM dynamic import,
cold synchronous SDK require/import in both loading orders, shared command-client
identity across the app and SDK, actual TypeScript consumer compilation under
the documented version/library-check matrix, and a browser-target bundle. The
minimum-Node job installs only SDK/contracts with the minimum Supabase peer and
strict engine enforcement, not Angular/app/compiler packages. It does not publish
packages, change branch protection, or enable automatic merging.

ESM-only does not by itself guarantee that every independently bundled subpath
shares every runtime object. The acceptance checks assert specific shared
identities rather than making that broader claim.

The launcher tests execute the actual `.mjs` source in a separate Node process,
with Node standing in for the Bun binary. They check argv, URL-sensitive paths,
missing-runtime diagnostics, successful/unsuccessful exits and POSIX signal
forwarding. Linux/macOS/Windows jobs run the portable cases; POSIX signal cases
are explicitly skipped on Windows, where POSIX graceful signals do not apply.
These isolated tests replace the old CommonJS `vm` test; the existing Lite
package smoke additionally exercises the installed launcher with Node and Bun.
They do not substitute for the full Lite database/package/standalone checks.

## Rollback

Before release, revert the breaking change. After release, consumers that still
need the old synchronous CommonJS contract can pin the last compatible version
while migrating. Restoring a CJS implementation would require an explicit
policy change, equivalent public declarations, consumer coverage and renewed
runtime-identity checks; do not disable the guard just to make CI green.
