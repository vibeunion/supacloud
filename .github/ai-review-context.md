# AI Review Context

This file is consumed by `.github/scripts/ai-review-merge.mjs`.

## Required baseline skills

These skills should be considered for every PR review in this repository:

- `agent-team-automation` - Task Contract, Task Ledger, progress/mailbox coordination, automation workflows
- `provider-adapter` - GitHub PR / CI visibility and review-state mapping
- `typescript` - Bun-compatible TypeScript and strict typing
- `bun-cli-cross-platform` - Bun CLI, setup/deploy/install scripts, cross-platform shell behavior

## Path-based skills

Add the following skills when the PR touches the matching area:

- `packages/management-api/**`, `packages/edge-runtime/**` -> `elysiajs`
- `packages/web-console/**/*.svelte`, `packages/web-console/src/routes/**`, `packages/web-console/src/lib/**` -> `svelte-code-writer`, `svelte-core-bestpractices`
- `packages/web-console/**` with Tailwind or UI styling changes -> `tailwind-v4`
- shadcn/ui components or registries -> `shadcn`
- `.agents/**`, `tasks.md`, `progress.md`, `.mailbox/**`, `.github/workflows/**`, `.github/scripts/**` -> `agent-team-automation`, `provider-adapter`

## Review contract reminders

- The review must check Task Contract goal, non-goals, acceptance criteria, required skills, verification plan, risk, and rollback.
- If the PR introduces or changes automation, provider routing, CI, permissions, auth, data migration, or production deployment behavior, the review should be conservative and request changes unless the contract and verification evidence are complete.
- Auto-merge is only acceptable when the diff is narrow, checks are green, and the review explicitly confirms the relevant skills and project conventions were followed.
