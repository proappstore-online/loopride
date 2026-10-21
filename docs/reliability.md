# Retries and idempotency

Issue #15. How every call that leaves the browser or crosses a trust boundary behaves when it fails or
is repeated. The rule throughout: **a repeat must be harmless, and a failure must be visible.**

Two kinds of "idempotent" are used below:

- **Naturally**: the same inputs leave the same state (an upsert on a fixed key, or a transition guarded
  by the state it leaves).
- **By key**: the caller supplies a key and a repeat with the same key is ignored.

A refused or repeated step is a **silent no-op that writes nothing and no audit row**; the app confirms
by re-reading state (see `transition_errors` in the [alerts](runbooks/README.md)).

## Platform actions (app.actions.call)

The browser does not retry a failed action on its own; the screens that poll simply ask again on the
next tick. Every failure is counted and reported (domain by action; `telemetry.ts`).

### Requests and quotes
| Action | Repeat is | How |
|---|---|---|
| `create_quote` | harmless | key `quote_id` (conflict ignored); older pending quotes are superseded |
| `accept_quote` | harmless | one ride per accepted quote; a second call, or a second ride id, changes nothing |
| `expire_stale_quotes` | harmless | naturally |
| `save_ride` | harmless | upsert by ride id; status only moves forward; a matched ride is not reopened |
| `cancel_ride` | harmless | guarded by the trip state; one cancellation, one fee |
| `save_rider_profile`, `save_place`, `delete_place` | harmless | upsert / delete by key |
| `delete_my_rider_data`, `delete_my_driver_data` | harmless | deletes by owner; split in two because a batch may hold 25 statements; the app calls both, and a failure part-way is retried safely |

### Dispatch
| Action | Repeat is | How |
|---|---|---|
| `request_dispatch` | harmless | upsert by ride; restarts only from `no_driver` or `cancelled`; refused while another active request exists or dispatch is paused |
| `dispatch_tick` | harmless | the rider's app calls it every ~4 s; at most one live offer per request and per driver (partial unique indexes), `INSERT OR IGNORE` |
| `accept_offer` | harmless | one transaction guarded by the offer state; a replay changes nothing |
| `decline_offer` | harmless | guarded by `offered` |
| `set_driver_availability`, `update_driver_location` | harmless | upsert |
| `save_driver_application`, `save_driver_vehicle`, `delete_driver_vehicle`, `submit_driver_application` | harmless | upsert / guarded by status |

### Trip lifecycle and tracking
| Action | Repeat is | How |
|---|---|---|
| `advance_trip`, `start_trip` | harmless | each step is guarded by the state it leaves; deterministic transition and event ids |
| `driver_cancel_trip`, `report_rider_no_show`, `report_driver_no_show` | harmless | guarded by an open, unstarted trip |
| `open_dispute` | harmless | one per participant per trip |
| `publish_driver_location` | harmless | overwrites the single latest position; updates under 3 s apart are dropped; the app sends one per 4 s, newest fix only, and warns the driver after 3 failures in a row |

### Notifications
| Action | Repeat is | How |
|---|---|---|
| (creating a notification) | harmless | deterministic id + `INSERT OR IGNORE`, written in the same transaction as the event |
| `list_pending_deliveries` | read | returns only what is due |
| `report_push_result`, `report_email_result` | harmless | accepted only from the person whose action caused it and only while unfinished; 3 attempts (after 30 s, then 2 min), then `failed` |
| `set_notification_prefs`, `mark_notifications_read` | harmless | upsert / idempotent update |

### Payments and the fare ledger
No payment is collected (ADR 0001), so there is no external payment call. Money records:
| Action | Repeat is | How |
|---|---|---|
| (finalizing a statement) | harmless | in the transaction that ends the trip; `INSERT OR IGNORE`; never edited |
| `ops_credit_trip` | harmless | by key `request_key`; total can never exceed the amount |
| `ops_request_refund`, `ops_escalate` | harmless | by key `request_key` |
| `ops_decide_refund`, `ops_resolve_escalation` | harmless | guarded by `requested` / `open` and a different person |

### Operations and observability
| Action | Repeat is | How |
|---|---|---|
| `review_driver_application`, `review_driver_vehicle` | harmless | guarded by the status it leaves |
| `ops_suspend_driver`, `ops_reinstate_driver` | harmless | guarded by `approved` / `suspended` |
| `ops_cancel_trip`, `ops_resolve_dispute`, `ops_log_access` | harmless / append | guarded by an open trip / open dispute; an access entry per call is intended |
| `ops_set_service_flag` | harmless | a repeat of the current state is ignored |
| `report_client_event` | best effort | deduplicated in the app (30 s) and capped at 20 per minute per person by the server; failures are swallowed |
| `report_client_metrics` | additive | counters for the same minute add up; a lost report loses that minute |

## Other external calls

| Call | On failure | Retry | Idempotent |
|---|---|---|---|
| **Geocoding** (`app.maps.geocode`, address suggestions) | suggestions empty; "Get quotes" says the address could not be found; reported as `maps` / `geocode_failed` | every keystroke after a 300 ms pause is a fresh request; a stale one is aborted | read |
| **Routing** (`app.maps.route`) for a quote | the trip cannot be priced; reported as `route_failed` | "Get quotes" again | read |
| **Routing** for the live map and ETA | map falls back to a straight line; ETA falls back to a straight-line estimate labelled approximate; reported | recomputed when the driver moves 150 m or after 30 s | read |
| **Web push** (`app.notifications.notifyUser`, channel push) | counted as failed when no device received it (`sent` is 0); reported | the server schedules 3 attempts, driven by the sender's app | the tag is the notification id, so a device shows a duplicate once |
| **Email fallback** (channel email) | `skipped` (unsubscribed / no address) is final; `failed` retried like push | 3 attempts | the platform sends a fixed template; only sent after push failed and with consent |
| **Browser geolocation** (driver) | the driver sees a warning and the rider sees "no live location yet"; reported as `location_unavailable` | the browser keeps watching | n/a |
| **Platform auth** | a 401 clears the session (SDK); actions report a `warn` | sign in again | n/a |
| **Tool registration** (deploy step) | the deploy fails and the previous tools stay live; caught within 15 minutes by the health-check workflow | fix and push | registration replaces the whole set |
| **Telemetry** (`report_client_*`, PAS app log) | silent | none (never retried, so it cannot loop) | see above |

## What is deliberately not retried

- Anything a person decides (cancel, accept, credit): a failure is shown and the person chooses to try again.
- Telemetry reports.
- SMS: not offered (the SDK only lets the app's creator send it).
