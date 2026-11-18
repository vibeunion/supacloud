# Monorepo workspace plan

Status: **P0 implemented**. This is a local, read-only plan. It does not build,
deploy, write project data, or register a push webhook. It is not deploy-time
enforcement. A ready plan is not an activation token and not a deployment receipt.

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

`pipeline connect` keeps generating a deploy workflow for a repository that has
no `supacloud.workspace.json`. When that file is present, the generated push
workflow runs `workspace plan` only. Existing frontend webhook deploys in the
Management API are unchanged.

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

`status` is `ready`, `unchanged`, or `blocked`.

- `ready`: at least one application is affected, every selected binding is valid,
  and the impact closure is known. Affected applications have `target` set to
  that environment's project ref and application id, plus planned `build` and
  `deploy` tasks with `executed: false`. Other applications have no tasks.
- `unchanged`: no input changed. No tasks. `configured_binding` still shows the
  selected environment so you can see the map. `target` is null.
- `blocked`: the map is invalid, or some impact could not be resolved. `target`
  is null and there are no tasks, so a commit cannot fall through onto another
  project. `diagnostics` and `unresolved` say what is wrong.

`executable` is always false. `execution.deploy_time_enforcement` is always
false. `execution.push_webhook` is `not-registered`.

A file under one application root affects that application. A file under a
shared package affects applications that depend on it, including through other
shared packages. An unrelated application is `unaffected` and has no task.

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

## Roadmap

These phases are not implemented.

### P1 — affected build and release

For a `ready` plan, run each affected application's existing build and the
existing `app release` / project deployment path. Show one delivery status per
application in the repository. Retry a failed project without rebuilding
unrelated applications. Unaffected applications still get no task. Unknown
impact still blocks rather than deploying a guess. Deployment receipts remain
the record of what shipped.

### P2 — approval, promotion, and unknown outcomes

Bind approval to the plan digest before promotion. Promote and roll back through
the existing artifact transfer and deployment receipt flow. Reconcile an unknown
outcome by reading the receipt for that project, application, and mutation.
Do not add a second transaction pipeline, a second ledger, or a fake approval
flag in the plan document.
