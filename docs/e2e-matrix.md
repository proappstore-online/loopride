# Live end-to-end journey matrix

Issue #17. The journeys that must not regress, automated against the **deployed** app after every deploy.
Code: `e2e/specs/matrix.spec.ts`, helpers `e2e/lib/live.ts`, registry `e2e/matrix.ts`. It builds on the
live-deploy QA in [qa.md](qa.md) (issue #16).

## The matrix

| Id | Journey | What it proves | Owning issues |
|---|---|---|---|
| J1 | Request to completion | quote, accept, dispatch offer, driver accepts, en route with a live position the rider can read, arrived, started, completed; a receipt exists; tracking stops; the driver is released | #6 request and quote, #5 dispatch, #7 lifecycle, #8 tracking, #9 receipts |
| J2 | No driver | with every driver offline a quote cannot be accepted and creates nothing; a search that finds nobody ends in `no_driver` after its 2 minute window and can be restarted (takes about 2 minutes) | #5, #6 |
| J3 | Decline and re-dispatch | the nearer driver is asked first; after they decline the next one is asked and the decliner never again; the second driver's acceptance matches the ride | #5 |
| J4 | Cancellation | the rider cancels after a match: outcome `rider_cancelled`, tracking stops, the driver is released and is offered the next request | #7, #5 |
| J5 | Stale GPS | the server reports the true age of the driver's last position while they are quiet (what the app turns into "Delayed" and "Last seen"); a fresh position replaces it | #8 |
| J6 | Stale GPS alert (slow, `E2E_SLOW=1`) | after 5 minutes without a position on an active trip `stale_tracking` fires, critical, with its runbook, and clears when a position arrives | #8, #15 |
| J7 | Rider report | an urgent safety report is visible to the rider, reaches the staff queue with trip context and no address or plate, opens a safety escalation, and acknowledging then resolving it closes both | #12, #11 |
| J8 | Driver suspension | staff suspend a driver: they go offline, leave the dispatchable list, cannot go back online and are not offered a ride; reinstating restores them | #11, #4, #12 |

The ids and titles are in each test's name (`J1 request to completion [#6 #5 #7 #8 #9]`), so the Playwright
output, `results.json` and the published summary all carry the owner.

## Accounts and data safety

The matrix needs four **dedicated test accounts** (never a real person), each with its own session token,
stored as repository secrets and passed to the `e2e` job in `.github/workflows/deploy.yml`:

| Secret | Role | Needs |
|---|---|---|
| `PAS_E2E_RIDER_TOKEN` (falls back to `PAS_E2E_SESSION_TOKEN`) | rider | nothing special |
| `PAS_E2E_DRIVER_TOKEN` | first driver | nothing special; the matrix onboards and approves it |
| `PAS_E2E_DRIVER2_TOKEN` | second driver (J3) | same |
| `PAS_E2E_OPS_TOKEN` | staff | the app role `ops` (grants approval, suspension, the safety queue, alerts) |

The four must be four different users. Without the tokens the matrix skips with a message naming what is
missing, and the rest of the suite still runs. `E2E_SLOW` (a repository variable) set to `1` adds J6.

How a live run stays safe:

- **Isolated place.** Every pickup and every test driver is in a remote spot (near Vostok Station, Antarctica)
  where no real driver or rider is, so a test search cannot reach a real driver and a real search cannot reach a
  test driver. Journeys run one at a time and each starts by cancelling what the last left open.
- **Marked data.** Ids carry a run id (`e2e<time><random>`), free text starts with `[e2e]`.
- **Real rules.** Driver onboarding, approval and consent go through the real actions; nothing is seeded or bypassed.
- **Cleanup.** Before the run (a crashed run may have left data) and after it, the matrix cancels open rides,
  takes the drivers offline and erases the rider's and both drivers' data with the app's own erasure actions.
  A problem in cleanup is logged and never hides a test result.
- **What is deliberately left.** Staff audit records are kept by design ([privacy.md](privacy.md)): the driver review
  log, the safety report with its escalation, and the staff access log. Each carries `[e2e]` in its note. J7 files a
  real urgent report, so the staff queue briefly shows one marked `[e2e] test report, please ignore`; it is
  acknowledged and resolved within the test.
- **Never run against anything but the app's own data service.** The helper only calls the app's actions and
  `/v1/auth/me`; it has no access to other apps or to the platform's admin routes.

## When it runs and what a failure gives you

- **When:** the `e2e` job runs after every successful deploy of `main` (`needs: deploy`) and fails the Deploy to R2
  run when a journey fails, which is the signal the PAS Agent Teams deploy gate reads (see [qa.md](qa.md)). Run
  by hand with `E2E_BASE_URL=... E2E_RIDER_TOKEN=... npx playwright test matrix.spec.ts` in `e2e/`.
- **Artifacts:** each failed journey attaches `action-trail.json` (every action in order with status, timing,
  inputs and result; tokens are never recorded) plus Playwright's trace and screenshot. The workflow uploads
  `e2e/test-results/` and `results.json` as the `e2e-artifacts-<sha>` artifact for 14 days.
- **Who owns it:** `e2e/report.mjs` writes a table to the job summary with every journey's result and its owning
  issues as links; a failed journey adds "Report it on #N", the first assertion that failed and its artifacts.
  `results.json` also feeds `kb.proappstore.online/loopride/.e2e/summary.json`, where Agent Teams reads it.

## Developing without touching the live app

`node e2e/fake-pas.mjs` starts a local stand-in for the actions API that runs the committed `migrations.json`
and `mcp.json` on real SQLite (it enforces the action SQL but not the platform's role gate):

```
node fake-pas.mjs &
E2E_API_BASE=http://localhost:8787 E2E_RIDER_TOKEN=rider E2E_DRIVER_TOKEN=drv1 \
  E2E_DRIVER2_TOKEN=drv2 E2E_OPS_TOKEN=ops E2E_BASE_URL=http://x npx playwright test matrix.spec.ts
```

It is how the matrix was checked before it ever ran live. A pass there is not a pass live: only the live run
exercises deployment, the platform's role gate and its real clock and network.

## Adding a journey

1. Add it to `JOURNEYS` in `e2e/matrix.ts` with its owning issues; add a test titled `tag(j('Jn'))`.
2. Keep it self-contained: use the shared actors, end by leaving nothing the next journey depends on.
3. Add the row to the table above. `web/src/docs.test.ts` fails the build when the registry, the spec and this
   page disagree, or when the spec calls an action that is not in `mcp.json`.

## Known limits

- The matrix drives actions over HTTP, not the browser UI; the UI is covered by the 375 px browser tests (#14) and
  the component tests. A bug that only exists in how a screen calls an action is not caught here.
- Push notifications and email fallback (#10) are not in the matrix: delivery needs a real device.
- The platform's role gate is only exercised by the live run (J7 and J8 use the staff account).
- J2 and J6 wait in real time (about 2 and 5 minutes).
