# Preview fix loop

One local pass that reads an application graph, applies one explicit command-mode
fix, compiles, invokes, and reads the invoke timeline. All of those writes stay
in a directory whose name is the preview branch ref from
`applicationPreviewBranchRef`. Production is read, then checked unchanged.

This command does not provision a preview. Database branches, queues, Storage
namespaces, test secrets, and activations stay on the existing preview
create/reconcile/cleanup flow. It does not deploy, publish to npm, or write
production. A production promotion still requires the existing approval path.

The directory must already exist and must be named `pv` plus the first 18 hex
characters of the preview id. The production directory and the preview directory
must be separate real directories, not symlinks, and neither may contain the
other. The only accepted edit is one `invalid-command-mode` (`SC4012`) diagnostic
for the property you name. `--value required` or `--value none` is mandatory;
the loop does not choose a policy.

```sh
supacloud-compiler preview-fix \
  --production ./production \
  --preview ./previews/pv123456781234423482 \
  --preview-id 12345678-1234-4234-8234-123456789abc \
  --project-ref demo \
  --application-id api \
  --environment-id test \
  --property transaction \
  --value required \
  --json
```

Success writes two files in the preview directory only:

- `preview-execution-events.json` — handler start and success for the invoked command
- `preview-deploy-receipt.json` — schema `supacloud.preview-deploy-receipt.v1`

The receipt records the graph, the change, the diagnosis, the invoke, and the
timeline. `deployed`, `published`, and `live` are false. `artifact_sha256` is the
sha256 of the preview's generated `application.ts`. It is not an application
release id and it is not a provisioning receipt.

`execute()` on the repaired command class is the invoke. The timeline is read
back from the preview events file. Stages the loop did not run stay in
`missingStages`. `complete` only means the last declared stage was observed as
succeeded.

```gherkin
Scenario: Fix inside the preview
  Given a broken command in an isolated preview directory
  And the same bytes in a separate production directory
  When the preview fix loop runs with an explicit transaction value
  Then the preview source, compile, invoke, timeline, and receipt exist
  And the production tree is unchanged
  And the receipt says deployed, published, and live are false
```
