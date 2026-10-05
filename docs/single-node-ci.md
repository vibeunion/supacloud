# Single-node CI acceptance

The repository uses `.github/workflows/single-node-platform.yml` for the
single-node delivery baseline.

## Automatic PR gate

The `contracts` job validates the deployment-evidence contract, Management API
routes, CLI readback, Developer MCP, Web Console, package type safety, delivery
build, SLO alert rules and the clean-diff boundary.

## Synthetic restore gate

Run the workflow manually with `run_restore_drill=true` to build the pinned
restore-drill image and exercise logical-full and pgBackRest recovery in an
isolated Docker network. These fixtures prove recovery logic only; they are
not production RPO/RTO evidence.

## Test and production acceptance

Manual `test` acceptance uses the protected `test` environment and must provide
the test host identity and Management API credentials as GitHub Environment
secrets. The workflow reads `hostname` and `hostname -I` before acceptance,
then runs `scripts/ci-single-node-acceptance.ts --refresh-evidence`.

Manual `production` acceptance uses the protected `production` environment and
is read-only. It does not deploy, restart or mutate production. The production
Environment must require human approval.

The acceptance script fails closed unless health, active runtime, deployment
evidence, backup freshness, recovery drill, authenticated smoke and rollback
readiness are all confirmed. `unknown` and `incomplete` never pass.
