# Project Storage adoption: complete source inventory

Adoption uses `storage.buckets.id` and `storage.objects.(bucket_id, name)` in the
project's own database as the authoritative catalogue. It does not use the old
platform driver's UI listing helpers to establish completeness: those helpers
can return one S3 page or hide an upstream error as an empty list. Every catalogued
object must be read successfully and hashed before copying. A missing object,
database error or source read failure aborts adoption without installing a binding.
Objects outside SupaCloud's metadata are not imported or deleted.

Empty logical buckets remain in the inventory and fingerprint. The object query
is bounded to 10,001 rows so the 10,000-object synchronous limit is enforced before
reading object bodies. Nested keys are preserved. TUS, signed-upload and S3
multipart records must be cleared through their normal completion/cleanup flows
before adoption; their presence conflicts rather than silently switching an
unfinished upload to another backend. Do not delete upload records to bypass this
check while an upload is active.

The registry's exclusive project and namespace locks cover source inventory,
copy/readback verification, the second inventory and binding commit. The second
inventory reads the metadata again and rehashes objects; changed source contents
or catalogue entries abort the cutover. As with the initial adoption contract,
operators must quiesce project traffic and external writers during this bounded
maintenance operation: registry locks are not a distributed transaction covering
arbitrary direct database or S3 writers. Bodies remain buffered, so object-count
limits are not a promise of unbounded per-object memory or migration duration.

Regression command:

```sh
cd packages/management-api
bun test tests/unit/project-storage-inventory.test.ts
```

The seven pure regressions cover a 1,001-object source whose UI listing exposes
only 1,000 objects, successful copy of the missing-page object, suppressed UI
listing errors, metadata failure redaction, missing source bodies, pending uploads,
early object limits, empty buckets and catalogue changes. The SQL fixture checks
routing and query shape, not native PostgreSQL transaction behavior. Retain native
PostgreSQL concurrency CI and real-provider production acceptance separately.
