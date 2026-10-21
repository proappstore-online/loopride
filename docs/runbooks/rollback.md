# Runbook: rollback and recovery

Use when a deploy broke something: `state_invariants`, `transition_errors`, `payment_records`, a
`*_error_rate` alert right after a deploy, or the health-check workflow failing.

## What a deploy is

`git push origin main` runs three workflows: **test** (typecheck, lint, unit and browser tests),
**Platform Compliance**, and **Deploy to R2**. Deploy to R2 (in order): applies `migrations.json`,
registers `mcp.json` as the app's actions, uploads the frontend. A failed registration fails the whole
job and **leaves the previous actions live**, so a green site with a red deploy means old actions are
still serving (this happened in #9: a batch tool grew to 26 statements and the platform's limit is 25).
The health-check workflow compares the registered tools with `mcp.json` every 15 minutes and fails if
they differ.

## Decide: pause first, then roll back

1. Health → **Pause dispatch** (reason `incident`) if rides are being affected. Active trips keep working.
2. Find the bad commit: GitHub → Actions → "Deploy to R2" → the first red or suspicious run, or the
   deploy right before the alerts started.
3. Fix forward if the fix is small and obvious; otherwise revert.

## Roll back the code

```
git revert --no-edit <bad-commit>        # a new commit that undoes it; never rewrite main
git push origin main                      # deploys automatically
```

Wait for the three workflows to go green, then check the live app. The revert re-registers the earlier
actions and uploads the earlier frontend. Do not force-push or reset `main`.

### Database migrations are forward-only

`migrations.json` is additive (`CREATE TABLE/INDEX IF NOT EXISTS` only; a test enforces it), and each
migration runs once. Reverting code **does not** remove tables or columns that a migration added; the old
code simply ignores them. That is deliberate: it makes a code rollback safe. Consequences:
- Never edit or delete a migration that has shipped; add a new one.
- An index or table added by a bad migration stays. If one must be removed, it is a hand-run
  operation by the app owner on the data service, not part of a rollback.
- Data written by the bad version (rows in new tables) stays; it is harmless to old code.

## Inconsistent states

Health → "Inconsistent states" lists them. Each code means:

| Code | Meaning | What to do |
|---|---|---|
| `completed_request_not_completed`, `cancelled_request_still_open` | a trip ended but its ride did not follow | escalate to the owner with the ids; do not edit by hand |
| `active_trip_without_lock`, `driver_locked_by_finished_trip` | the driver's lock and the trip disagree: a driver may be unable to receive rides | escalate; as a stopgap support can cancel the trip (reason `other`), which releases the lock |
| `matched_without_trip` | an accept did not finish creating the trip | the rider can cancel and search again |
| `search_never_ended` | a rider's search is still open past its deadline (the rider closed the app) | harmless; the next request by that rider is refused until it ends, so cancel it from Trips |
| `trip_stuck_open` | a trip has been open over 6 hours | contact the driver; cancel with reason `driver_request` or `safety_incident` |
| `finished_without_outcome`, `finished_without_lifecycle` | a trip ended without its lifecycle record | escalate; this means a code path ended a trip outside the audited actions, which is a bug |

Escalate through the Escalate action (level `lead`) so there is a record. Do not repair rows by hand.

## Payments

No payment is collected and statements are never edited. `payment_records` firing means a finished trip
has no fare statement, a statement differs from its accepted quote, or credits exceed the amount. Run
the reconciliation (`ops_reconcile`) to see which trips, [roll back](#roll-back-the-code) if a deploy
caused it, and correct amounts only with a credit (Trips → Credit), never by editing a statement.

## After any rollback

1. Alerts clear over the next window; "Inconsistent states" is empty.
2. Resume dispatch.
3. Write the incident up: what broke, when it was noticed, how, how long, who was affected, the fix, and
   the check that would have caught it earlier (add the check as an alert or a test).
