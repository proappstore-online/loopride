# Security review: authorization, secrets, logs, abuse limits

Issue #13. A review of how personal data is protected, done against the committed `mcp.json`,
`migrations.json`, workflows and client source. Where a check can be automated it is a test in
`web/src/lib/privacy.schema.test.ts` (the describe blocks "security review" and "export and erasure"), so the
findings below stay true. Items that need a decision or more work are listed as **open**.

## Authorization

All access to data is through registered actions (end users cannot run SQL on PAS). Every action runs
as the signed-in caller (`:__user_id`).

| Check | Result | Evidence |
|---|---|---|
| Every action requires a signed-in caller | Pass | test: "every action requires a signed-in caller..." |
| Every staff action declares an app role (`ops`, `ops_pii`) | Pass | same test |
| Riders and drivers read only their own rows; strangers get nothing from the self-service and export actions | Pass | test: "a rider or driver reads only their own rows..." |
| Ownership is in the key: every rider-owned table is keyed `(rider_id, id)` and filtered on the caller | Pass | docs/domain-model.md; domainSchema tests |
| A driver reaches a trip only through the assignment that names their account | Pass | domainSchema tests (#7, #8) |
| Staff read of names, addresses, plates in trips, exact coordinates and licence details needs `ops_pii`, a logged reason, and lasts 10 minutes; staff cannot read their own trips | Pass | test: "the personal-data reads do return them, but only after a logged reason..." |
| No other staff read returns a name, phone, address or licence number | Pass | test: "exact coordinates, names, addresses and licence details need ops_pii" runs every staff query and searches the output |
| Staff cannot approve, cancel, credit or refund their own application, trips or requests | Pass | docs/domain-model.md; domainSchema tests |

**Fixed here.** `list_dispatchable_drivers` (role `ops`) returned each driver's full name. It now returns an
initial, like the application list. It also returns the plate, which staff need to identify the vehicle they are
reviewing; that is intended.

**Fixed here.** `set_driver_availability`, `update_driver_location` and `publish_driver_location` accepted a
position or an online flag from any approved driver whether or not they had agreed to location sharing.
They now require the matching consent (docs/privacy.md).

**Open.** The consent check on the server tests that a consent exists and is on, not that it was given for
the current notice wording; only the app asks again when the wording changes.

## Secrets

- The repository holds no secrets. A search for key, token, password and bearer assignments finds only
  `${{ secrets.* }}` references in the deploy workflow (`PAS_E2E_SESSION_TOKEN`, `INTERNAL_TOKEN`), which are
  GitHub Actions secrets.
- The browser bundle holds no payment credentials, and `web/src/compliance.test.ts` fails if one appears.
- The platform session token lives in the SDK; the app stores only ride data, the mode and one timestamp in
  `localStorage` (inventory: `device:*`).
- The web app calls only the platform API (CSP `connect-src` in `web/public/_headers`).

**Open.** The CSP allows `'unsafe-inline'` scripts. It predates this issue and is needed by the platform shell
as it stands; confirm with the platform whether it can be tightened.

## Logs

- Telemetry records opaque trip and ride ids, action names, status codes and timings. Free text is redacted
  (emails, coordinates, long tokens, phone-like numbers) and clipped to 200 characters
  (`web/src/lib/telemetry.ts`, tested in `telemetry.test.ts`). The server accepts only `warn`/`error` and a
  snake_case code and keeps events 14 days.
- The only free text that reaches telemetry comes from the browser's geolocation error message, the push
  error the SDK returns, and fixed strings in the app; all of it goes through the redaction above.
- The staff audit trail (`ops_access_log`, `driver_review_log`, `ops_escalations`) records who, what scope
  and the reason code, not the personal data itself.
- `ErrorBoundary` writes the crash and component stack to the user's own browser console only.

**Open.** Staff notes (`note` on cancellations, credits, refunds, escalations) are free text and can
contain personal data; nothing checks it. They are not exported and are kept with their records.

## Abuse and rate limits

| Surface | Limit |
|---|---|
| Location updates | at most one per 3 s per trip; implausible coordinates, accuracy over 500 m and speeds over 70 m/s are dropped; drivers only, only on their own active trip |
| Diagnostic events | 20 per minute per person; metrics 7 rows per call |
| Dispatch | offers expire, a driver holds one active assignment, `dispatch_tick` is time-gated |
| Quotes | expire after a short window; accepting is single-use |
| Saved places | at most 50 per rider (added here) |
| Driver vehicles | at most 10 per driver (added here) |
| Location consent, profile, preferences, availability | upserts on the caller's own key, so they cannot add rows |
| Trip steps, cancellations, no-shows | each is state-guarded: a legal transition happens once |
| Disputes | one per person per trip, within 7 days of the trip ending, note clipped to 200 characters on the server |
| `purge_expired_data` | deletes only rows past their window; safe to repeat, but any signed-in user can trigger it |

A test lists every action that creates rows and fails until a new one is either capped or classified with
its reason.

**Open: `save_ride`.** A rider can create any number of ride requests (and the driver, vehicle, quote and
trip rows that go with them), because the ride id is chosen by the client. This is a storage-growth
and noise risk for one account, not a cross-account one. A cap needs a product decision (recurring rides are
legitimate and numerous) and a change to all the statements in the batch. Until then rely on the platform's
per-app request limits.

**Open: platform limits.** Whether the platform applies its own per-user request rate limit to registered
actions is not documented in this repository, so none is assumed. The per-action limits above stand alone.
