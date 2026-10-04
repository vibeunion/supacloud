# @supacloud/delivery

Shared delivery manifests, immutable object inventories, verified artifact
readers, and deployment evidence contracts. Used by the compiler and the
Management API without making either depend on the other.

`readDeliveryExecutableArchive(manifestPath)` returns verified HTTP/Worker
artifact bytes for all targets in an application release. It never imports
application code. `readDeliveryMigrationArchive(manifestPath, target)` validates
archived migration metadata and SQL bytes without executing SQL.

Neither reader proves runtime readiness, migration compatibility, deployment,
or data recovery. These remain platform acceptance requirements.

`supacloud.deployment-evidence.v1` is the platform-side read model for those
acceptance results. It records the immutable build, environment binding,
database provider, component health, activation identity, authenticated smoke
test and rollback readiness. `parseDeploymentEvidence` fails closed:
`unknown` observations never become `confirmed`, and missing recovery or
rollback proof remains `incomplete`.

The database provider is represented as data (`provider`, `version`, `topology`,
migration, backup and recovery evidence). The current single-node platform can
use `postgresql`; this contract does not implement YugabyteDB or distributed
orchestration.

Bun consumers use the shipped TypeScript sources; Node consumers use `dist`
after `bun run build`. Types resolve from the same shipped source contracts.
The compiler's Node-targeted bundle uses the `supacloud-source` export condition
to include these sources directly, without depending on a prior library build.
The schema, build-schema, files and artifact subpaths support compiler
compatibility exports and share one implementation with the platform reader.
