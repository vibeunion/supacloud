# Region ship

Region ship copies one verified logical-full backup archive into a directory
for another region from the project region catalog. The bytes stay on this
host. That local directory is the loopback transport.

A target region database is not started. The ship receipt records
`target_apply` as `not executed` and `transport` as `loopback`. Retrying the
same backup id returns the stored receipt when the archive digest still
matches. It does not register a read replica and it does not call the scaling
path that adds one.

## Contract

- Source region is the project's `region`. Both source and target must be
  catalog codes, and they must differ.
- `POST /v1/projects/:ref/database/backups/logical/:backupId/region-ship`
  with `{ "target_region": "<code>" }` reads the verified logical backup and
  copies its archive. Admin auth is required.
- `GET /v1/projects/:ref/database/backups/logical/:backupId/region-ship/:targetRegion`
  re-reads that receipt and archive. It does not create directories.
- The store root is `SUPACLOUD_REGION_SHIP_DIR`, default
  `/var/lib/supacloud/region-ship`. Layout:
  `<root>/<target-region>/<project-ref>/<backup-id>.dump` and a sibling
  `.json` receipt.
- The receipt schema is `supacloud.region-ship.v1`. `target_apply` is
  `not executed`. Changing that field, or the archive bytes, makes the next
  read fail instead of reporting success.

Not deployed. A remote region process was not executed.
