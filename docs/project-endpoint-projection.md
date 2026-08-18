# Project endpoint projection

SupaCloud exposes one authoritative, secret-free projection of the public project endpoints. The projection is derived by the Management API from the same routing configuration used to configure the gateway; clients must not rebuild domains from project names or refs.

## Management API

A project credential or admin credential may read one project:

```http
GET /v1/projects/:ref/endpoints
```

Delegated Studio/BFF reads map this route to the existing `project.read` capability.

Only an admin credential may enumerate all projects:

```http
GET /v1/projects/endpoints
```

The response schema is `supacloud.project-endpoints.v1` and contains `api`, `auth`, and `studio` entries. Every entry includes:

- `origin`: canonical HTTP(S) origin;
- `host`: canonical hostname;
- `aliases`: additional API hostnames, when configured;
- `source`: `explicit`, `derived`, or `generated`;
- `status`: control-plane lifecycle status (`configured`, `pending`, `inactive`, or `unknown`);
- `verification`: currently `not_checked`.

`status` does not claim that public DNS, certificate issuance, or an external network path has been verified. The first version intentionally reports `verification: not_checked` rather than manufacturing an external readiness result.

## CLI boundaries

Read the selected project from the project CLI:

```bash
supacloud-cli project endpoints --ref abc123
```

Cross-project enumeration remains a platform operation:

```bash
supacloud-admin project list
supacloud-admin project endpoints --ref abc123
supacloud-admin project list_endpoints
```

`supacloud-cli project list` returns a boundary message directing operators to `supacloud-admin`; it does not enumerate projects with a project-scoped command surface.

Both CLIs validate a fixed response schema, reject unknown fields, bind single-project responses to the requested ref, and never print project config or credentials.

## Backup compatibility boundary

The release CLI continues to accept only verified `logical-full` backup inventory and restore receipts. `project restore` remains a project lifecycle operation and is not a database restore command.

Legacy `management-full` archives are not imported or restored by this change. A future compatibility importer requires a real archive fixture or an authoritative format specification, read-only inspection and planning, archive integrity checks, a current-state backup, and an explicit migration contract. Until those inputs exist, rejecting the old format is safer than guessing at its contents.
