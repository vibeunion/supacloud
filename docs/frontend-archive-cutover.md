# Frontend Archive Cutover

## Scope

The one-time offline preparation tool verifies a frozen v1 deployment copy,
repackages every retained ZIP into deterministic tar.zst, and records the digest
mapping. It is not a runtime compatibility reader. The v2 API continues to reject
ZIP uploads and v1 release metadata.

Run only on a private, quiesced recovery copy. Preserve the old binaries,
database/journal backup and gateway configuration separately. A deployment copy
does not prove the complete old platform is recoverable.

The source directory contains the original `deployment.json`,
`active-release.json`, `releases/<sha256>/{release.json,archive.zip,build/}`, and
`project-mutations.json`: the original normalized `ProjectMutationState[]` export
from the old platform. Do not edit old records to make verification pass.
Current and previous selection comes from the current successful activation's
checkpoint, never release sorting.

Preparation produces upload archives and a reviewable manifest, not an installed
live inventory. It does not write authority, mutate journals, configure routes,
start a server, or restore a database. Fresh activation IDs, approved upload and
activation, current/previous route equivalence, and full old-platform recovery
remain separate cutover gates.

```bash
bun run scripts/frontend-archive-cutover.ts \
  --source /private/recovery/web --project-ref demo --deployment-id web

bun run scripts/frontend-archive-cutover.ts \
  --source /private/recovery/web --project-ref demo --deployment-id web \
  --prepare --plan-digest <reviewed-sha256> --output /private/prepared/web
```

Run from `packages/management-api` with its development dependencies installed.
Planning writes nothing. Preparation requires a new directory under a trusted
private parent and revalidates the source against the approved digest. Ordinary
candidate writes use Bun APIs; frozen-input reads use held no-follow descriptors.
An interrupted or failed preparation can leave an incomplete output directory;
without a valid final `cutover-plan.json` it is not a completed bundle. The tool
never removes existing output or retries over it.

The bundle contains `archives/`, derived v2 `releases/<sha256>/release.json`
records and `cutover-plan.json`. It is not a live storage layout: there are no
active pointers or replacement mutation receipts. Equivalent ZIPs share one
candidate and retain all old digest mappings; their candidate metadata preserves
the earliest source creation timestamp. Actual upload must obtain a fresh,
verified v2 platform receipt rather than treating derived metadata as one.

## Acceptance

```gherkin
Scenario: Inspect without changing the recovery copy
  Given a frozen v1 deployment and its original successful mutation export
  When the tool plans an archive cutover
  Then all retained archives and trees are verified
  And the plan includes the exact current and previous identities
  And neither source nor output is written

Scenario: Repackage only proven-equivalent content
  Given a ZIP whose decoded paths or bytes differ from the retained tree
  When a plan or preparation is requested
  Then the operation fails without publishing a bundle

Scenario: Bind preparation to review
  Given an approved plan digest and a changed source inventory
  When preparation is requested
  Then the digest mismatch stops publication
  And old authority, journals and receipts remain unchanged

Scenario: Publish a separate upload bundle
  Given an unchanged approved plan and a new output directory
  When preparation succeeds
  Then the bundle records every old-to-new digest mapping
  And every candidate uses strict v2 metadata
  And no old activation identity or successful receipt is rewritten
  And cutover and live recovery remain unverified

Scenario: Refuse ambiguous activation evidence
  Given an unresolved mutation or invalid current or previous successful journal
  When planning is requested
  Then no target is selected or guessed from inventory order
```
