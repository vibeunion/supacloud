# Preview and Supabase compatibility

SupaCloud already has a Supabase-compatible branch and environment model. A
preview must run **on** that model, not beside it. This note records the
mapping and corrects earlier preview work that composed a parallel namespace and
identity.

## Existing surface (the one to reuse)

| Concern | Existing implementation | Supabase correspondence |
| --- | --- | --- |
| Branch record | `projects.config.branches` (`BranchRecord` in `routes/branches.ts`, `auto-branching.service.ts`) | Management API branch: `ref`, `name`, `parent_ref`, `status` |
| Branch lifetime | `branch_type` (`preview` / `persistent`) | Preview vs persistent branch |
| Data mode | `data_mode` (`schema_only` / `full_clone`) | `with_data = false` / `true` |
| Git binding | `git_branch`, `git_commit` written by auto-branching | branch `git_branch` / PR metadata |
| Provisioning | `branchService.createBranch` / `deleteBranch` | branch create/delete |
| Preview state | `branch.preview` on the branch record (`createBranchPreviewStore`) | branch metadata |
| Migrations | `supabase_migrations.schema_migrations` ledger | Supabase migration ledger |
| Auth roles | `supabase_auth_admin`, GoTrue runtime per branch | GoTrue stack |
| Config/activation identity | `ApplicationConfigurationIdSchema` / `ApplicationActivationIdSchema` in `@supacloud/delivery` (UUIDv4) | project config/activation ids |

## Rules

1. **One branch model.** A preview composes from an existing active branch of the
   project via `previewInputFromBranch(...)`. It reuses the branch `ref` as both
   `preview_ref` and `branch_ref`, and marks `branch_preexisting: true`.
2. **No duplicate lifecycle.** `createPreviewDatabasePort` does not create or
   delete a `branch_preexisting` branch; branch create/delete stays owned by the
   branch service and its routes. Otherwise a preview would clone a second
   database and delete a branch the user still has open. Preview state is stored
   on the branch record, not in a parallel collection.
3. **Platform identity stays canonical.** Configuration and activation ids
   follow the `@supacloud/delivery` UUIDv4 contract. The preview-internal
   content-addressed `cfg_` revision is accepted only for local composition and
   must never be handed to the activation contract.
4. **Supabase-compatible keys.** `project_ref` is `^[a-z0-9-]{1,20}$`. A preview
   ref is a change identity (`pr-<n>`, `change-<id>`) or an existing branch ref
   (20 hex), never a raw branch name.
5. **`with_data` semantics.** `schema_only` maps to `with_data = false` (the
   default); `full_clone` maps to `with_data = true` and still requires explicit
   authorization and pre-masked data.

## Non-goals

- No second branch store, branch type, or activation identity.
- No automatic cloud resource creation, IAM, or managed-preview parity.
- No production credentials or addresses in branch metadata or preview output.

Referenced from [Preview environments](./preview-environment.md).