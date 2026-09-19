# Migrating to default Command governance

The compiler and Elysia adapter now reject incomplete Command governance by
 default, rather than waiting for the first protected request. The compiler
policy and runtime adapters are separate requirements; metadata does not
implement authorization, persistence, transactions or audit.

## Compiler policy

When `commandCapabilities` is omitted, both `compileProject` and `checkProject`
use `requirePersistentAdapters: true` and enable permission, audit, idempotency
and transaction capabilities. Configuration loaded through
`defineSupacloudConfig` uses the same defaults.

A local Command on this path needs a nonempty permission and audit event, with
`transaction: "required"` and `idempotency: "required"`. The host must actually
supply the corresponding runtime adapters. A named RPC must be declared in the
compiler capability map and registered in the host's runtime RPC map. Global
local adapters do not satisfy a missing named RPC registration.

For an external operation, explicitly declare an external adapter and use
`transaction: "none"`. Use the existing durable external-command runtime and
reconciliation; do not describe a remote side effect as a database transaction.
See [Command migration](command-migration.md) for the existing persistence flow.

An explicit `commandCapabilities` object is a complete policy override, not a
partial object merged into the defaults. Do not use `{}` merely to register
options later: that selects legacy capability behavior. A deliberate migration
can set `requirePersistentAdapters: false` with truthful capability flags, but
this does not remove the requirement to declare permission, implement real
runtime governance or satisfy any other compiler diagnostics. Restore the
strict profile before claiming default-policy acceptance.

## Startup and execution

`createApplication` and `createModulePlugin` check registered Command descriptors
even when no HTTP route directly binds a Command. In the standard governance
path, the host must provide a callable `authorize`, both audit callbacks for a
declared audit event, and callable transaction/idempotency ports where required.
Named RPC ports need their own callable `execute` and declared capabilities.
Inherited RPC properties are not registrations. Invalid setup fails during
application construction, before requests are served; service construction is
not a database connectivity or durability test.

An explicit custom `commandExecutor` remains supported for existing native
Command boundaries. It must enforce or delegate the whole policy, not just call
`next()` to satisfy the startup check. The Webhook example registers an executor
that validates its binding and delegates to the compiler-generated
`UpdateWebhook` service and the existing persistent adapter. It does not add a
second receipt store, transaction implementation or business continuation.

The SupAuth-style `createCommandAuthorizationAdapter` requires `resource:action`
permissions and a trusted authenticated identity. This syntax check belongs to
that adapter; existing custom authorization boundaries may use their established
permission naming. Application/catalog mismatches and malformed resolver data
are not permission grants. Never derive trusted identity from request bodies.

## Upgrade verification

Upgrade the compiler and host adapter together, regenerate the application,
and review both `application.ts` and `app.manifest.json`. Run typechecks and the
application tests, including startup with missing adapters, denied access,
idempotent replay after revocation, and rollback when audit fails.

Under normal compilation (`writeOnError` unset or false), a governance error
must preserve both the previous executable factory and its manifest. Do not
use `writeOnError: true` to produce deployable artifacts from invalid input.
`checkProject` is read-only: callers must inspect error diagnostics as well as
`upToDate`, which reports artifact drift, not authorization-policy validity.
After repairing the source or host registration, rerun the checks before
promotion. A successful metadata check alone is not proof of real database
atomicity, cross-tenant isolation, remote reconciliation or SupAuth integration.

Related implementation: [compiler defaults](../packages/compiler/src/compile.ts),
[startup adapter](../packages/elysia/src/index.ts), and
[Webhook composition](../packages/elysia/src/webhook-migration-example.ts).
