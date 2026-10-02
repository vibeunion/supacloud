# SDK module compatibility

## Supported loading contract

`@supacloud/js` is a public SDK, not the server framework. Its root,
`@supacloud/js/task-events` and `@supacloud/js/contracts` support ESM `import`,
dynamic `import()` and **synchronous `require()` on Node 22.12.0 or newer**.
Bun 1.4.2 is included in the installed-consumer checks. Use a maintained runtime
with current security patches; 22.12.0 is a module-loader capability floor,
not a recommendation to deploy that old patch release.

```js
// ESM
import { createClient } from '@supabase/supabase-js';
import { createSupaCloudClient } from '@supacloud/js';
```

```js
// CommonJS on a supported Node version: no await and no loader shim.
const { createClient } = require('@supabase/supabase-js');
const { createSupaCloudClient } = require('@supacloud/js');
const { TaskEventError } = require('@supacloud/js/task-events');
const { createCommandScope } = require('@supacloud/js/contracts');
```

The client factory remains synchronous; network methods keep their existing
Promise contracts. A module-format change does not introduce an initialization
Promise, new requests, implicit retry, storage, or a second command engine.
Continue creating the Supabase client with application-owned credentials and
options, and pass it to `createSupaCloudClient` as documented in the README.
Service-role workflow/command operations remain server-only.

## One implementation, two loading APIs

The existing ESM `.js` files and `.d.ts` declarations remain canonical.
`type: module` already makes `.js` ESM; renaming them to `.mjs` is unnecessary.
Each public export has `types`, `module-sync`, `import` and `default` conditions,
in that order. All runtime conditions point to the **same file**. Consequently,
`require()` and `import` share the same exported classes and functions within
one installed SDK copy and one process. We do not publish a separate CJS build,
an asynchronous CJS shim or a second copy of the shared contracts package.

This is **modern CommonJS caller compatibility through Node's ESM loader**, not
classic CommonJS-distribution support. Node before 22.12.0, environments that
disable synchronous ESM loading, old bundlers that insist on CJS source,
embedded/Electron runtimes below that floor and React Native/Hermes are not
certified by these checks. Dynamic import alone does not make an unsupported
runtime or a third-party dependency supported. A verified requirement for those
environments would need a separate design for real CJS artifacts and declarations;
do not claim compatibility merely because a file has a `.cjs` suffix.

The runtime floor is now explicit in `engines.node`. Previously the SDK had
ESM-only artifacts without this declared Node floor. Treat the engine declaration
as a compatibility change in release notes, not as a promise to preserve older
Node installations. No existing CJS SDK artifact is removed by this change.

## Dependency and type safety

The SDK and every dependency reachable from a synchronous entrypoint must remain
free of top-level `await`. Adding it, even in a transitive dependency, breaks
synchronous `require()` and must fail the cold-process acceptance tests.
Do not work around failures by returning a Promise from `require()` or copying
contract code into a separate CJS bundle.

ESM and CommonJS callers use the same ESM declarations. TypeScript `NodeNext`
consumers are checked in both `.mts` and `.cts` files, including
`import sdk = require('@supacloud/js')`, checked factory arguments and generic
results. `ESNext`/`bundler` consumers are checked separately. The repository
compiler version is used; this does not certify every older TypeScript version
or the older `node16`/`node18` module-resolution models. Separate `.d.cts`
declarations would describe a different CJS artifact that we do not ship.

Framework packages such as `@supacloud/app` and `@supacloud/compiler` retain
ESM-first contracts and do not acquire the SDK's synchronous-loading promise.
Third-party CommonJS compatibility in Edge Runtime is not removed.

## Verification and release gate

After building contracts, delivery, app, SDK and compiler:

```sh
bun run --cwd packages/supacloud-js check:package
node .github/scripts/esm-package.acceptance.mjs
```

The acceptance workflow installs real candidate tarballs outside the checkout.
It runs Node 22.12.0, Node 24, Node 26 and Bun consumers, with separate fresh
processes for require-first and import-first order. It compares every exported
runtime value, checks error `instanceof` identity and verifies the SDK's command
client against `@supacloud/contracts/client`. An actual CommonJS Supabase client
with a local fetch stub checks factory synchrony, HTTP error preservation and
one-attempt behavior without network requests. All SDK subpaths are included in
a browser-target build, and TypeScript is actually executed, not merely configured.

Metadata/fixture tests verify the guard and test harness. Only the installed
consumer job proves the candidate SDK/dependency graph works; CI must pass on
the release commit before declaring these integrations verified. Duplicate
installed SDK versions or separate JavaScript realms are outside the single-copy
identity guarantee. The workflow does not certify every supported peer version
or all browser/mobile environments.

References: [Node package conditions](https://nodejs.org/api/packages.html#conditional-exports),
[Node require(ESM)](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require),
and [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference).
