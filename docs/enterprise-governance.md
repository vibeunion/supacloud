# Enterprise governance

This is the control-plane slice for organization membership, teams, project
collaborators, audit export, and API key rotation. It is not a deployment and
it does not call an identity provider or a KMS API.

## What is enforced

Organization members stay on `organization_members` with roles `owner`,
`admin`, `member`, and `viewer`.

Teams live under an organization. A team role is only `maintainer` or
`member`. That label does not grant project access.

A team project grant chooses `admin`, `member`, or `viewer` on a project that
belongs to the same organization. It can also set a capability allowlist.
The allowlist narrows the role's existing collaborator capabilities. It cannot
add capabilities the role does not already have, and it cannot grant
`owner`.

When the organization member has a GoTrue `user_id`, the grant writes
`project_collaborators` with `created_by = organization-team:<team id>`.
`requireCapability` then uses the allowlist. If a collaborator row already
exists and was not created by that team, the grant is stored and the link is
reported as `skipped_existing_collaborator`. An existing owner row is not
demoted or removed. A member without `user_id` is reported as
`principal_missing` until a principal is linked.

Removing the team membership, the grant, the team, or the organization member
releases only those team-managed collaborator rows.

Project RBAC (`/v1/projects/:ref/rbac/...`) remains the existing GoTrue
metadata projection. This slice does not add a second permission engine.

## Audit export

`POST /v1/projects/:ref/audit/exports` is unchanged: one project, `jsonl` or
`csv`, at most 50,000 rows.

`POST /v1/organizations/:slug/audit/exports` checks that `project_ref` belongs
to the organization and calls that same export. The download URL stays on the
project route. There is no cross-project archive.

## Key rotation

| Kind | Route | Effect |
| --- | --- | --- |
| `legacy_jwt` | `POST /v1/projects/:ref/api-keys/rotate` | Replaces `jwt_secret`, anon key, and service-role key, restarts the project runtime, and invalidates user sessions |
| `opaque` | `POST /v1/projects/:ref/api-keys/rotate-opaque` | Replaces the publishable and secret keys. It does not rotate `jwt_secret` or restart the runtime |

Successful rotation writes one audit event, `project.api_keys.rotate` or
`project.api_keys.rotate_opaque`. The event records the kind and
`material_recorded: false`. It does not store key material.

## SSO / SAML

The real seam is the project GoTrue admin proxy:

- `GET/POST /v1/projects/:ref/auth/sso/providers`
- `GET/PUT/DELETE /v1/projects/:ref/auth/sso/providers/:id`

`GET /v1/organizations/:slug/sso` lists projects in the organization and those
routes. `GET /v1/organizations/:slug/projects/:ref/sso/providers` checks
organization ownership and calls the same GoTrue list. Assertion validation,
IdP metadata handling, and session creation stay in GoTrue.

There is no organization-level identity provider and no discovery for a domain
that GoTrue has not been configured with.

## SCIM

`GET` and `POST` of `/v1/organizations/:slug/scim` return HTTP 501 with
`reason_code: scim_not_implemented` after the same admin authentication as
other organization routes.

`GET` and `POST` of `/v1/projects/:ref/auth/scim`, including `/Users` and
`/Groups`, use the same project auth gate as the SAML provider routes and
then return that same 501.

GoTrue ships an experimental SCIM router behind a feature flag. SupaCloud does
not enable it, proxy it, store SCIM tokens, or sync directory users into
organization members.

## BYOK / KMS

`POST /v1/projects/:ref/auth/oauth-server/kms-rs256` stores an `aws:kms:arn` on
the project RS256 JWT signing JWK, together with the caller-supplied public
JWK. SupaCloud does not call AWS KMS, does not hold the customer private key,
and does not encrypt the database, storage, backups, or control secrets with
that key.

`GET /v1/organizations/:slug/projects/:ref/key-custody` reports how many
signing keys and how many `aws:kms:arn` references are present. It does not
return the ARN or any JWK material.

No other KMS provider is integrated.

## Admin boundary

Organization governance routes use the same admin authentication as
`/v1/organizations`. Project collaborator capabilities remain the enforcement
seam for delegated project access.
