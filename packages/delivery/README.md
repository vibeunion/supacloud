# @supacloud/delivery

Shared delivery manifests, immutable object inventories, and verified artifact
readers. Used by the compiler and the Management API without making either depend
on the other.

`readDeliveryExecutableArchive(manifestPath)` returns verified HTTP/Worker
artifact bytes for all targets in an application release. It never imports
application code. `readDeliveryMigrationArchive(manifestPath, target)` validates
archived migration metadata and SQL bytes without executing SQL.

Neither reader proves runtime readiness, migration compatibility, deployment,
or data recovery. These remain platform acceptance requirements.

Bun consumers use the shipped TypeScript sources; Node consumers use `dist`
after `bun run build`. Types resolve from the same shipped source contracts.
The compiler's Node-targeted bundle uses the `supacloud-source` export condition
to include these sources directly, without depending on a prior library build.
The schema, build-schema, files and artifact subpaths support compiler
compatibility exports and share one implementation with the platform reader.
