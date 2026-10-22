# Live-deploy QA (PAS Agent Teams)

RideShare is verified against the deployed app, not only with local tests
(issue #16).

## What runs where

- **Local/CI unit + component tests:** the `test` workflow runs `pnpm typecheck`,
  `pnpm lint`, `pnpm test`, and `pnpm test:e2e`. These run against a local build.
- **Live e2e:** the `e2e` job in `.github/workflows/deploy.yml` runs after every
  deploy. It runs `e2e/specs/*.spec.ts` with Playwright against
  `https://loopride.proappstore.online`. A red spec fails the Deploy to R2 run.
- **Results:** the job writes `summary.json`. With `INTERNAL_TOKEN` set, it
  publishes the file to `kb.proappstore.online/loopride/.e2e/summary.json`.
  Agent Teams harvests it into the project's Test tab.

## QA agent ownership

The QA agent owns `e2e/specs/`. Agent Teams bundles keep authored specs. The
platform only injects its baseline smoke when no specs exist.

- `smoke.spec.ts`: the app boots, and the sign-in state is correct.
- `rideshare.spec.ts`: rider trip planning, and switching between rider and driver.
- `matrix.spec.ts`: the live journey matrix (request to completion, no driver, re-dispatch, cancellation,
  stale GPS, rider report, driver suspension). Needs four test accounts; see [e2e-matrix.md](e2e-matrix.md).

A ticket that changes a user-facing flow adds or updates a spec in the same
change. Signed-in specs skip until the repo secret `PAS_E2E_SESSION_TOKEN`
holds a fixture session.

## Deploy gate

An Agent Teams ticket deploy completes only when the CI run for **its own
commit** is green (`deploy-stage.ts` → admin `/api/deploy-status` with the
pushed SHA). The live `e2e` job is part of that Deploy to R2 run. A red QA
result therefore fails the deploy and sends the ticket back to Dev with the
Playwright output. A ticket is not done without a green QA result.

## GitHub ↔ PAS ticket traceability

- **PAS ticket → GitHub:** the ticket's first line is
  `GitHub: proappstore-online/loopride#<n>`.
- **GitHub → PAS ticket:** the issue gets a comment
  `PAS ticket: loopride#<seq> (<ticket uuid>)` when the ticket is created.
- **Commits** use `Refs #<n>` or `Closes #<n>`, plus `PAS loopride#<seq>` when
  a PAS ticket drives the commit.
