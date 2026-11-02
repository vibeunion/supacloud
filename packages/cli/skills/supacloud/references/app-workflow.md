# Application authoring workflow

Load this reference when creating or changing a SupaCloud application, feature,
route, command, query, job, contract or resource. These actions are local unless
the request explicitly deploys or mutates a remote project.

## Loop

```bash
# 1. Create a project or inspect the existing project.
supacloud app init --root ./orders-api --name orders-api --format json
supacloud app context --format json > context.json
supacloud app doctor --format json > doctor.json

# 2. If doctor reports a preview-ready diagnostic, inspect its fix payload.
supacloud app fix --fix <reviewed-fix.json>
# Apply only after review; then re-run check and doctor.
supacloud app fix --fix <reviewed-fix.json> --write

# 3. Generate the smallest owned scaffold.
supacloud app generate --kind module --name orders --format json
supacloud app generate --kind controller --module orders --format json
supacloud app generate --kind command --module orders --name accept --format json
supacloud app generate --kind query --module orders --name list --format json
supacloud app generate --kind job --module orders --name sync-orders --format json
supacloud app generate --kind contract --module orders --name accept --format json

# 4. Verify the narrow change.
supacloud app compile
supacloud app check --format json
supacloud app verify-plan --target orders
bun test <returned-test-file>
git diff --check
```

## Guardrails

- Read `app context` before broad edits. Do not scan the whole repository or read
  `generated/**` as the source of truth.
- Edit maintained sources, then regenerate. Never hand-edit `generated/**`.
- Keep feature code and colocated tests under the generated feature directory.
- Generate with explicit business inputs (`--permission`, `--rpc`,
  `--database-source`, `--database-table`, `--database-type`) when required.
  Never invent authorization, persistence or database ownership.
- `app fix` is preview-only by default. `--write` applies one reviewed fix; it
  does not prove business correctness or authorize production changes.
- Use `verify-plan` and the returned focused test first. Do not default to the
  full test suite unless the change crosses shared boundaries.
- Local app actions do not require Management API credentials. Remote deploy,
  database and project operations still require the selected project context.
- Do not weaken compiler governance to make a diagnostic disappear. Fix the
  source or report the required explicit input.
