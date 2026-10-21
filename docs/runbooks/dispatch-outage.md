# Runbook: dispatch outage

Use when `matching_failures`, `offer_timeouts`, `dispatch_error_rate`, `stale_tracking`,
`degraded_tracking` or `dispatch_paused` is firing, or riders report "no drivers" or a stuck search.

## 1. Decide what kind of problem it is (5 minutes)

Operations → Health. Read the firing alerts and "Errors reported by the app" for the dispatch domain.

| You see | Likely cause | Go to |
|---|---|---|
| `dispatch_error_rate` firing, errors with HTTP 5xx or no status | the platform or data service is failing | step 3 |
| `matching_failures` with few errors and few drivers online | genuinely no drivers (time of day, a local event) | step 2 |
| `offer_timeouts` | drivers are not seeing offers (their app is closed; push only reaches the person whose action caused it, and offers reach drivers by polling every 5 s) | step 2 |
| `state_invariants` | something wrote an inconsistent state | [rollback](rollback.md#inconsistent-states) |
| `stale_tracking` | see [below](#riders-cannot-see-their-driver) | below |

Also check the [platform status](https://api.proappstore.online/health) (`{"ok":true}`) and the latest
"Health check" and "Deploy to R2" runs on GitHub: a recent deploy that failed or just landed is the most
common cause.

## 2. No drivers is not an outage

If error rates are normal, there is nothing to repair. Check "Drivers": are approved drivers
available? Drivers stay offline until they opt in, and their location must be under 5 minutes old and
within their own radius and 15 km of the pickup. Tell support what riders should be told; consider a
short pause so riders are not left searching (step 3).

## 3. Contain: pause new requests

Health → **Dispatch switch** → choose a reason, write what is wrong, **Pause dispatch**. New ride requests
and quote acceptances are refused with a clear message ("New ride requests are paused for a short time…").
Searches already running, trips in progress, tracking and notifications are not affected. This is audited
(Audit shows who paused it and why).

## 4. Look after people already affected

- Riders stuck searching: they see "No drivers are available right now" after 2 minutes and can search again; nothing to do.
- Trips matched but not moving: Trips tab → search by ride id → inspect (assignment, dispatch history, timeline, location evidence). If the driver is unreachable, **Cancel trip** with reason `driver_request` or `safety_incident` and no fee.
- Anyone locked by a finished trip, a match with no trip, a search that never ended: Health → "Inconsistent states" lists them with ids. These do not fix themselves; escalate to the owner with the ids.
- Credit riders who were charged a fee because of the outage: Trips tab → **Credit** (reason `fare_error` or `goodwill`).

## 5. Recover

1. Fix or wait out the cause. If it was a bad deploy, [roll back](rollback.md).
2. Confirm: the alerts clear over the next window, a test ride matches, and "Inconsistent states" is empty.
3. **Resume dispatch** (the same control; reason `resolved`).
4. Watch Health for 15 minutes. Write down what happened, how long, how many riders, and what would have caught it sooner.

## Riders cannot see their driver

`stale_tracking` (critical) means an active trip has had no location for 5 minutes. Location is sent by
the driver's phone every 4 seconds while the driver screen is open, so the usual causes are:
- the driver closed the app or the screen locked (wake lock is requested while driving, but not every browser grants it);
- the driver denied location (`location_unavailable` appears in errors);
- the network is down for the driver (`publish_failing`);
- the service is failing (`tracking_error_rate`).

Contact the driver through support. The trip itself still works: the driver can complete it without
sharing location, and evidence snapshots are only kept when a fresh position exists. If many trips are
stale at once it is the service, not the drivers: treat as step 1 → 3.
