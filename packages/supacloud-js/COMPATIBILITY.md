# SDK module compatibility

## Supported loading contract

`@supacloud/js` publishes native ESM (`.mjs`) and CommonJS (`.cjs`) builds for
its root, `/task-events`, `/contracts` and `/reactive` entrypoints.
`@supacloud/contracts` publishes both formats for its root, `/client` and
`/browser` entrypoints. Both builds come from the same TypeScript source.

Each export selects `.mjs` with `.d.mts` declarations under `import`, and `.cjs`
with `.d.cts` declarations under `require`. Legacy `main`, `module` and `types`
fields point to CJS, MJS and ESM declarations respectively. Consumers should
use public package specifiers instead of internal `dist` paths.

```js
// ESM
import { createClient } from '@supabase/supabase-js';
import { createSupaCloudClient } from '@supacloud/js';
```

```js
// CommonJS: synchronous, without an ESM loader bridge.
const { createClient } = require('@supabase/supabase-js');
const { createSupaCloudClient } = require('@supacloud/js');
const { TaskEventError } = require('@supacloud/js/task-events');
const { createCommandScope } = require('@supacloud/js/contracts');
```

The supported SDK Node floor remains **22.12.0**; native CJS output does not
lower dependency runtime requirements. CI also covers Node 24, Node 26 and
Bun 1.4.2. These checks do not certify older Node, Electron, React Native/Hermes
or every browser/bundler combination.

Client creation remains synchronous. Network methods retain their Promise
contracts, transport behavior and caller-owned authentication configuration.
Module loading does not create another client or introduce retries.
Service-role workflow and command operations remain server-only.

## Module identity

The formats have equivalent public APIs but distinct function and class
identities. Do not rely on cross-format `instanceof` or reference equality.
Repeated loading of the same entrypoint in the same format preserves identity.
The SDK contracts facade externalizes `@supacloud/contracts/client`, preserving
shared protocol identity within each format. Mixed-format applications should
exchange data or caller-owned clients rather than rely on class identity.
Independently installed package copies and separate JavaScript realms also
have independent identities.

## Type compatibility

The type-only Supabase bridge explicitly selects both upstream declaration
graphs with `resolution-mode: import` and `resolution-mode: require`.
Both SDK declaration formats accept either upstream client and preserve the
caller's exact client/database type without casts or type erasure.

Installed `.mts` and `.cts` NodeNext consumers check normal and opposite-format
Supabase clients, task generics, table-name inference and reactive query types.
TypeScript 5.8.3 checks the complete declaration graph with `skipLibCheck: false`.
TypeScript 7 checks the consumers and ESNext/bundler surface with
`skipLibCheck: true`: upstream auth-js `PublicKeyCredentialFuture<T>` currently
conflicts with the newer DOM WebAuthn declarations (TS2430). This is not a
successful TS7 full-library declaration audit.

Framework packages such as `@supacloud/app` and `@supacloud/compiler` remain
ESM-only. The dual-format policy exception is restricted to SDK and Contracts.

## Verification

Build Contracts before the SDK, then run:

```sh
bun run --cwd packages/supacloud-js check:package
node .github/scripts/esm-package.acceptance.mjs --sdk-only
```

Acceptance installs actual candidate tarballs outside the checkout, with no
workspace links. It checks cold require-first/import-first processes under
Node and Bun, all seven public entries, API parity, per-format identity,
Supabase HTTP error/Response preservation and one-attempt transport behavior.
The minimum peer is installed with strict engine enforcement. TypeScript runs
against the installed declarations, and a browser-target bundle includes all
SDK public entries. The full acceptance job additionally checks app/compiler
integration. CI must pass on the candidate commit before merging.
