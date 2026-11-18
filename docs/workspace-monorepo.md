# Monorepo workspace plan

Status: **P0 plan, plus explicit P1 delivery and P2 approval/promotion**.
`workspace plan` does not build or deploy. Delivery commands require
`--execute`. A ready plan is not an activation token. Production workspace
writes require a server approval. Deployment receipts remain the success record.

## Terms

| Term | Meaning |
| --- | --- |
| Repository | The git checkout that holds the code. It is not a SupaCloud project. |
| Application | A directory that can be built and released on its own. |
| Environment | A named stage such as `staging` or `production`. |
| SupaCloud project | The runtime and data isolation boundary. One database per project. |

One repository may contain many applications. Each application declares an
explicit binding from an environment to one project ref and one application id.
The planner never infers a project from a directory name, a git remote, or
another environment.

## What this reuses

These existing pieces stay in place:

- Per-application `supacloud.json` still describes one application or frontend.
  When an application directory has `application.id`, it must match the workspace
  application id. `application.environmentId`, when set, must match the
  environment you pass to `workspace plan`. It is not a project target.
- `app deploy-plan` still observes one stored release in one project. The
  workspace plan does not call it and does not replace it.
- Release upload, artifact transfer, promotion, and deployment receipts stay the
  authority for anything that actually ships. This plan does not write those
  ledgers and does not add a second one.
- Compiler `supacloud.environments.v1` still binds infra resources to `local` or
  `scheme:name`. It is not this map.
- `scripts/workspace` (`bun run workspace:affected`) still analyzes this
  SupaCloud repository's own `packages/` graph. Customer applications do not use
  that runner. The customer planner copies only its input rule for git: renames
  are shown as the old path and the new path (`--no-renames`), and a baseline
  that cannot be resolved is reported instead of guessed.

`pipeline connect` keeps generating a deploy workflow only when
`supacloud.workspace.json` is absent. A symlink, including a dangling symlink,
or any non-regular entry is rejected and no deploy workflow is written. A
regular workspace file selects the plan-only workflow. GitHub replaces
`supacloud-deploy.yml` with that plan. An existing GitLab `.gitlab-ci.yml` is
not overwritten: the command fails and tells you the file was left unchanged
and can still deploy. Remove it before writing the plan-only workflow. Existing
frontend webhook deploys in the Management API are unchanged.

## Onboarding

A storefront, an admin app, and a worker live in one checkout. Each one ships
to its own staging project and its own production project. Shared packages live
under `packages/`.

```json
{
  "schema": "supacloud.workspace.v1",
  "applications": [
    {
      "id": "storefront",
      "root": "apps/storefront",
      "build": "bun run build",
      "environments": {
        "staging": { "project_ref": "store-stg", "application_id": "storefront" },
        "production": { "project_ref": "store-prd", "application_id": "storefront" }
      }
    },
    {
      "id": "admin",
      "root": "apps/admin",
      "build": "bun run build",
      "environments": {
        "staging": { "project_ref": "admin-stg", "application_id": "admin" },
        "production": { "project_ref": "admin-prd", "application_id": "admin" }
      }
    },
    {
      "id": "worker",
      "root": "apps/worker",
      "build": "bun run build",
      "environments": {
        "staging": { "project_ref": "worker-stg", "application_id": "worker" },
        "production": { "project_ref": "worker-prd", "application_id": "worker" }
      }
    }
  ],
  "shared_paths": ["packages/*"]
}
```

Save that document as `supacloud.workspace.json` at the repository root. The
filename is fixed so a checkout has one map. The schema name is
`supacloud.workspace.v1`.

Give each shared package and each application a `package.json` `name`. Depend on
in-repo packages with `workspace:*`, `file:`, or `link:`, or with a version
range whose name matches exactly one package in this map. `dependencies`,
`devDependencies`, `peerDependencies`, and `optionalDependencies` all count.

Project refs use the platform shape: 1–20 characters, lowercase letters, digits,
and hyphens. The longer example string `project-store-staging` is not a valid
project ref. The binding `application_id` must equal the workspace application
`id`. Do not put database URLs, tokens, or passwords in this file. `build` is
intent text for a later phase. P0 stores it and does not run it.

## Command

From the repository root:

```bash
supacloud workspace plan --environment staging --base <known-commit>
supacloud workspace plan --environment production --base <known-commit> --format json
supacloud workspace plan --environment staging --changed changed.txt
```

`--environment` is required. Pass either `--base` or `--changed`, not both.
`--changed` is a regular file inside the repository with one relative path per
line. `--head` defaults to `HEAD` and is only valid with `--base`.

The command is local. It does not need an API token. It does not run the build
string, does not call the Management API, and does not write the checkout.

Text output names each application, why it is in the plan, and the exact target
project when one is selected. `--format json` prints `supacloud.workspace-plan.v1`.
The same inputs produce the same document, including `plan_sha256`.

## How to read a plan

`status` is `ready`, `unchanged`, `no-impact`, or `blocked`.

- `ready`: at least one application is affected, every selected binding is valid,
  and the impact closure is known. Affected applications have `target` set to
  that environment's project ref and application id, plus planned `build` and
  `deploy` tasks with `executed: false`. Other applications have no tasks.
- `unchanged`: the change set is empty. No tasks. `configured_binding` still shows the
  selected environment so you can see the map. `target` is null.
- `no-impact`: at least one input changed, and every changed path was classified,
  but no application is affected. `changed_files` stays populated. No tasks are
  selected. This is not a claim that the commit was empty.
- `blocked`: the map is invalid, or some impact could not be resolved. `target`
  is null and there are no tasks, so a commit cannot fall through onto another
  project. `diagnostics` and `unresolved` say what is wrong.

`executable` is always false. `execution.deploy_time_enforcement` is always
false. `execution.push_webhook` is `not-registered`.

A file under one application root affects that application and every application
that depends on it, including through other applications. The same reverse
closure is used for a shared package. A cycle is visited once. An unrelated
application is `unaffected` and has no task. A shared package with no
application dependents produces `no-impact`, not `unchanged`.

`build` is stored only when it is a literal intent. Environment assignments
such as `TOKEN=value`, and command text that names a token, secret, password,
or API key, are rejected. The rejection does not repeat the command.

These inputs do not silently drop a dependent:

- A path outside every application root and shared package is `unowned-input`.
  The plan is blocked. Every application id is listed in `possible_dependents`.
  None is given a task.
- A shared directory with no readable `package.json` name cannot explain its
  dependents. Every application is `unknown`, and the plan is blocked.
- A `workspace:`, `file:`, or `link:` dependency that does not land on one
  in-repo package is `unresolved-dependency`. The declaring application stays
  in the plan as `unknown`.
- A git baseline that cannot be resolved has the same effect: unknown impact,
  no project selected.
- Deleted paths are matched by their repository path even when the file is
  already gone. Renames contribute both the old path and the new path.

Symlinks are not followed. Absolute paths, `..`, overlapping roots, duplicate
ids, duplicate JSON keys, and a binding whose `application_id` differs from the
workspace id all block the plan. Two applications may bind the same environment
to the same project only when their application ids differ, which matches the
platform rule that one project can host more than one application. They may not
bind one environment to the same project and the same application id.

## Current limits

- Closure is package-manifest edges. Import statements that are not declared in
  `package.json` are not traced. If a shared path has no package name, the plan
  blocks instead of guessing who imports it.
- Path segments are limited to letters, digits, `.`, `_`, `@`, `+`, and `-`.
  `node_modules` and `.git` are not shared packages.
- `build` may not contain shell metacharacters, `..`, or a URL. That constraint
  is on the stored intent. P0 still would not execute a wider string.
- There is no Management API for this plan. The repository stays on the machine
  that runs the CLI. A future read API would need its own authorization boundary
  and must not treat this document as a write token.
- `supacloud deploy`, `app release`, and frontend push webhooks behave as they
  did before. P0 does not intercept them. A workspace checkout is protected only
  when you run `workspace plan` (or the plan-only workflow from `pipeline connect`).
- Changing `supacloud.workspace.json` marks every application affected for the
  selected environment, because the map itself changed.

`repository` is an explicit source identity such as `github.com/acme/store`.
It is not a URL, a user, a scheme, a credential, or a database connection.
`user:secret@host` is rejected, and the rejected value is not copied into the
error. Execution refuses to run when the field is absent. The string is hashed
to `repository_id` on the server.

## Execution

`workspace plan` stays read-only. Delivery commands do nothing until `--execute`
is present. Push workflows generated by `pipeline connect` stay plan-only.

```bash
supacloud workspace execute --environment staging --base <commit> \
  --plan-sha256 <plan-sha256> --source-revision <head-sha> \
  --configuration-id <uuid> --execute

supacloud workspace retry --environment staging --base <commit> \
  --plan-sha256 <plan-sha256> --source-revision <head-sha> \
  --mutation-id <existing-id> --execute

supacloud workspace promote --environment production --base <commit> \
  --source-environment staging --plan-sha256 <plan-sha256> \
  --source-revision <head-sha> --approval-id <server-approval> \
  --release-id <source-release> --application <application-id> \
  --configuration-id <uuid> --execute

supacloud workspace rollback --environment production --base <commit> \
  --plan-sha256 <plan-sha256> --source-revision <head-sha> \
  --approval-id <server-approval> --release-id <release> \
  --configuration-id <uuid> --activation-id <activation> \
  --expected-activation-id <current-or-absent> --execute

supacloud workspace reconcile --environment production --base <commit> \
  --mutation-id <existing-id> --execute

supacloud workspace status --environment staging --changed changed.txt --format json
```

`--source-revision` must equal the commit `git` reads from the checkout. The
CLI does not treat the flag as its own proof. `--base` and `--head` use the
same git diff as `workspace plan`. `--changed` must be a regular file inside
the checkout; a symlink or a path outside the checkout is rejected before it
is read. `--plan-sha256` must match a fresh plan. A mismatch selects no project.

Staging `--execute` is the user-authorized build. Affected applications are
built once for a source revision and config digest, then uploaded through the
existing release archive route. The release inventory is read first. An
authentication, network, or server failure is not an empty inventory, and no
upload follows that failure. Production `--execute` does not build or upload.
It activates a release that is already stored and already approved. A missing
or mismatched approval stops before any build or upload. Build the release on
staging, approve that digest, then deploy production.

Promotion and rollback name one application and one release id. They do not
select the newest release. Retry reads the activation receipt for the existing
mutation id and reuses that release. It does not select another release from
the inventory. An unknown, accepted, or absent outcome is reconciled on that
same id and is not redeployed. Reconcile reads the mutation status in the
response. `pending`, `accepted`, and `outcome_unknown` stay unknown. A response
that changes the id is rejected and no replacement id is created.

Workspace activation, promotion, rollback, and reconcile call workspace routes.
Those routes require project authentication and `applications.manage` before
the existing executor runs. Staging activation does not require a digest
approval. Production activation and promotion do. The existing `app deploy`,
`app promote`, and `/activations` routes are not intercepted. They remain a
bypass of this approval.

`workspace status` reads runtime for every configured environment binding. Each
observation is marked `authoritative: false`. The deployment receipt remains
the record of success. The Web Console application page stays single-project;
it is not a repository view.

## Approval

Production promotion and production activation require
`POST /v1/projects/:ref/workspace-approvals`. Grant and consume both require
project authentication and `applications.manage` on that project. Read requires
`applications.read`. The record binds repository, application, environment,
project, release id, manifest digest, config digest, source revision, and
workspace plan digest. The actor is stored and audited, and is not part of the
approval id. Any later principal with `applications.manage` on the same project
may consume that grant. A different actor does not create a second approval.
The first insert wins, including when two grants arrive together. A changed
release, manifest, project, or plan digest does not match and does not run the
executor. A local JSON flag is not read and is not approval.

The grant is written to the existing project audit log. The table
`workspace_release_approvals` stores the approval only. Platform schema setup
creates it with the other platform tables. A request does not create the
table. The table does not record deployment success and it is not a second
deployment ledger.

Direct `app deploy` and `app promote` are unchanged. They are not intercepted
by this approval. The workspace routes are the gated path.

## Still not shipped

- The approval table is created by platform schema setup. An integration test
  rolls the table back when a local PostgreSQL server is reachable. That test
  is skipped, and reported as skipped, when it is not.
- `workspace promote` loads the existing promotion plan and posts it to the
  gated route. A promotion that the existing planner blocks, including
  migration, backup, smoke, or source-readiness blockers, still does not
  promote. This change does not weaken those checks.
- The Web Console does not render the multi-project status document.
- No production project was contacted, and nothing here was deployed.
