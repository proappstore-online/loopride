# Observability, alerts and runbooks

Issue #15. This is where to look when something is wrong, and what each signal means.

## What is recorded

Everything is non-personal: opaque trip and ride ids, action names, HTTP status, timings and a
redacted, clipped (200 character) detail. Never names, addresses, coordinates, contact details or
person ids. Redaction is in `web/src/lib/telemetry.ts` and tested.

| Signal | Written by | Kept | Read in |
|---|---|---|---|
| **Structured errors**: a domain, a short code, the action, status, latency, trip/ride id, severity (`warn` or `error`) | the app, on every failed platform action, failed map call, undelivered notification, location-sharing failure, rejected trip step, missing receipt, and render crash | 14 days in `client_events`; also the PAS app log (category `loopride.<domain>`) | Operations → Health → "Errors reported by the app"; `ops_list_client_events` for one trip; PAS console logs |
| **Metrics**: calls, failures, slow calls (over 2 s) and summed latency per domain per minute | the app, flushed every minute and when the page hides | `client_metrics` (per person per minute) | Operations → Health → "Calls by area" |
| **State consistency**: trips, rides and offers that disagree | computed on demand from the tables, so nothing can skip it | n/a | Operations → Health → "Inconsistent states" |
| **Audit of every staff action** (including pausing dispatch and every personal-data access) | the actions themselves | permanent | Operations → Audit |

Domains: `request` (quotes, rides, account), `dispatch` (matching, offers, availability), `tracking`
(live location), `notification`, `payment` (fare statements and receipts), `maps` (geocoding and
routing), `transition` (trip lifecycle steps).

Severity: server and network failures are `error`; 4xx answers (an expired session, a lost race) are
`warn`. The same failure repeating is reported once per 30 seconds and a client sends at most 10 events
a minute, so an error loop cannot flood the database.

## Alerts

Open **Operations → Health** (the tab shows a count when anything fires, refreshed every minute; the
page itself refreshes every 30 seconds). Every check is computed in SQL over a window (default 15
minutes, up to 2 hours) by `ops_health_alerts`. Firing checks sort first, critical before warning, and
link to the runbook.

| Alert | Severity | Fires when | Runbook |
|---|---|---|---|
| `matching_failures` | critical | at least 50% of at least 3 searches that ended in the window ended with no driver | [dispatch outage](dispatch-outage.md) |
| `offer_timeouts` | warning | at least 70% of at least 6 answered offers expired or were declined | [dispatch outage](dispatch-outage.md) |
| `dispatch_paused` | warning | operations paused dispatch | [dispatch outage](dispatch-outage.md) |
| `stale_tracking` | critical | an active trip (driver en route or arrived) has had no location for 5 minutes | [dispatch outage](dispatch-outage.md#riders-cannot-see-their-driver) |
| `degraded_tracking` | warning | at least half of at least 2 active trips have had no location for 1 minute | [dispatch outage](dispatch-outage.md#riders-cannot-see-their-driver) |
| `state_invariants` | critical | any trip, ride or offer states disagree (list below) | [rollback](rollback.md#inconsistent-states) |
| `transition_errors` | critical | the app reported at least 3 trip steps refused that it had offered as legal | [rollback](rollback.md) |
| `notification_failures` | warning | at least 5 pushes or emails failed after all retries | [notification outage](notification-outage.md) |
| `notifications_undelivered` | warning | at least 10 notifications still undelivered after 10 minutes | [notification outage](notification-outage.md) |
| `payment_records` | critical | a finished trip has no fare statement, a statement is not its quote, or credits exceed the amount | [rollback](rollback.md#payments) |
| `<domain>_error_rate` for request, dispatch, tracking, notification, payment, maps | warning | at least 20 calls in the window and at least 10% failed | the matching runbook |

Inconsistent states (`ops_health_invariants`): a completed trip whose ride is not completed; a cancelled
trip whose ride is still open or matched; an active trip with no accepted offer; a driver still locked
by a finished trip; a match with no trip after 2 minutes; a search whose deadline passed over 2 minutes
ago; a trip open over 6 hours; a finished trip with no recorded outcome or no lifecycle record.

**Where alerts reach people.** The app has no server-side process, so an alert is a check someone
looks at, not a page. Staff keep the Health tab open during an incident and on a quiet day look at it
at the start of a shift. A scheduled GitHub Action ([`health-check.yml`](../../.github/workflows/health-check.yml),
every 15 minutes) probes from outside: the site serves the app, the PAS API answers, and the tools the
platform has registered match `mcp.json` (a failed registration leaves the live app on old actions).
A failing run emails the repository's watchers. **Known gap:** nothing pages anyone for the in-app
alerts; wiring that needs a server-side sender and a service identity, neither of which exists.

## Who does what

- **Operations (`ops` role)**: Health tab, pause/resume dispatch, cancel trips, escalate.
- **App owner**: grants roles, owns deploys and rollbacks, reads the PAS console logs, and is the
  escalation point when an incident is a platform problem.
- Every action above is audited.

## Related

- [Retry and idempotency of every external call](../reliability.md)
- [Dispatch outage](dispatch-outage.md), [map outage](map-outage.md), [notification outage](notification-outage.md), [rollback](rollback.md)
