# Vibecoding Evaluation

Evaluate business changes, not framework API count. The versioned task
definitions are `VIBECODING_TASKS` in `scripts/vibecoding-eval.ts`:

1. Create and register a catalog resource with allowed/denied read tests.
2. Repair a response-contract mismatch without weakening checks.
3. Extend a governed orders command with denial, version and duplicate tests.

Use separate disposable branches with the same starter, dependency versions,
model settings and initial task context for comparisons. The command task uses
the explicit command recipe or an existing governed application, not fabricated
persistence in a minimal application.

Record one trial per agent run:

```json
{
  "version": 1,
  "trials": [{
    "id": "example-only",
    "task": "create-resource",
    "elapsedMs": 1000,
    "contextBytes": 2048,
    "repairRounds": 0,
    "firstCheckExitCode": 0,
    "finalCheckExitCode": 0,
    "changedFiles": ["src/features/catalog/catalog.ts"]
  }]
}
```

The numbers above are schema examples, not measured performance. Capture actual
wall time, context size, check exits, repair rounds and changed paths from the run.
Include untracked paths. Keep prompts, source contents, credentials and raw logs
out of the report. Retain reviewed test output separately as evidence.

```sh
bun scripts/vibecoding-eval.ts recorded-trials.json
```

The evaluator reports success and first-pass rates, mean elapsed/context/repair
costs, changed-file counts and out-of-scope changes. Passing checks do not excuse
changes outside the task's allowed paths. Invalid records and duplicate trial
identities fail closed.

It deliberately labels results as recorded, not independently attested. It does
not run a model, infer success from a chat message, prove business correctness
or certify deployment. Do not claim an improvement until comparable real agent
runs have been recorded and reviewed.

Daily verification uses `app verify-plan --target <module>` and a directly
relevant single test file. Generated drift, consumer types, real PostgreSQL/RLS,
authenticated behavior and delivery read-back remain release/adoption gates.
