# RideShare domain model

The production data model behind Loopride/RideShare (issue #1). It replaces the
single recurring-first `RecurringRide` record with explicit entities stored in
the app's PAS D1 database.

- **Schema:** `migrations.json` (repo root). It is applied by the Deploy to R2
  workflow before the frontend uploads. It is additive only and tracked in
  `_migrations`, so re-running it is a no-op.
- **Writes:** registered actions in `mcp.json` (`save_ride`, `cancel_ride`,
  `list_ride_requests`). End users can't run raw SQL on PAS, so every
  read and write goes through these actions. Each statement is scoped to
  `:__user_id`.
- **Client bridge:** `web/src/lib/rideRecords.ts` maps a client ride to
  `save_ride` params.

## Ownership and IDs

Every row belongs to one **rider**, the signed-in PAS user who created the
ride. Every table except `riders` has the primary key `(rider_id, id)`, so:

- one rider can never read, overwrite or cancel another rider's rows (all
  action SQL filters on `rider_id = :__user_id`);
- client-chosen ids can't collide across riders.

IDs are deterministic, derived from the client ride. That is what makes the
migration idempotent.

| Entity | Table | `id` | Owner |
|---|---|---|---|
| Rider | `riders` | PAS user id | the user |
| Driver | `drivers` | `drv_<slug(driverName)>` | rider |
| Vehicle | `vehicles` | `veh_<slug(plate)>` | rider |
| Ride request | `ride_requests` | client ride id (`crypto.randomUUID()`, or the legacy Loopride id) | rider |
| Quote | `quotes` | `<rideId>:quote` | rider |
| Assignment | `assignments` | `<rideId>:assignment` | rider |
| Trip | `trips` | `<rideId>:trip` | rider |
| Trip event | `trip_events` | `<tripId>:<status>` | rider |

Drivers and vehicles are the rider's records of who drives them. `drivers.user_id`
is reserved for linking a driver's own PAS account. Driver-side access (a driver
reading their assignments) will be a new action keyed on that column; it isn't
built yet.

## Lifecycles

| Entity | States | Transitions |
|---|---|---|
| Driver | `active`, `inactive` | created `active` |
| Ride request | `open`, `matched`, `paused`, `completed`, `cancelled` | `open` → `matched` once a driver is assigned; `paused` while a routine is paused; `completed` when its trip completes; `cancelled` via `cancel_ride` (a soft delete). Re-saving the ride, e.g. with Undo, reopens it. |
| Quote | `offered`, `accepted`, `expired` | a fare the rider requested with is stored `accepted` |
| Assignment | `offered`, `accepted`, `declined`, `released` | an assigned driver is stored `accepted` |
| Trip | `scheduled`, `en_route`, `arrived`, `completed`, `cancelled` | follows the driver's progress; `cancel_ride` cancels an unfinished trip |
| Trip event | `type = status` | one row per trip status reached, with `at` = when it was first recorded; later replays don't change it |

Live GPS positions stay ephemeral (PAS rooms / BroadcastChannel) and are not
trip events.

## Trip history and transitions (issue #2)

`trips` holds the current state; `trip_transitions` (migration `0002_trip_history`)
is the append-only audit log. Each row records `from_status`, `to_status`,
`actor_type` (`rider` / `driver` / `system`), `actor_id` (the PAS user), `at` and
free-form JSON `metadata`. Nothing updates or deletes it. `trip_events` keeps its
one-row-per-status-reached role.

Valid moves: `scheduled → en_route → arrived → completed`, and any unfinished
state → `cancelled`. `completed` and `cancelled` are terminal. Enforcement is in
the action SQL (D1 has no stored procedures), and an invalid or replayed move is
a silent no-op rather than an error:

- `advance_trip` (driver): strict single steps or cancel, only for a trip whose
  assignment's driver has `drivers.user_id = :__user_id`. Completing or
  cancelling also updates the ride request.
- `save_ride` (rider sync): forward-only. It never moves a trip backwards or out
  of a terminal state, so Undo of a cancel reopens the ride request but not the
  cancelled trip. Re-saving an existing trip with no history backfills one
  transition with a null `from_status`.
- `cancel_ride` (rider): records a `cancelled` transition for unfinished trips.

Read paths, all scoped to the caller: `list_my_trips`, `get_my_trip_history`
(rider, `rider_id = :__user_id`) and `list_driver_trips`,
`get_driver_trip_history` (driver, via `drivers.user_id`).

**Not built yet:** a flow that sets `drivers.user_id` (a driver claiming their
account). Until then the driver actions return nothing and change nothing.

## Rider account (issue #3)

Route `/account` (linked from Home). Migration `0003_rider_profile` adds
`rider_profiles` (name, phone, email/SMS/trip-update preferences) and
`saved_places`; client code is `web/src/lib/riderAccount.ts`.

- **Trip history:** `list_trip_history` returns the rider's requests with trip
  status and fare. The client groups them: *active* (on-demand, or a trip
  `en_route`/`arrived`), *scheduled* (scheduled/recurring, not started),
  *completed*, *cancelled*. Cancelled trips exist only in the DB (they are
  deleted from the local cache), so signed-in history reads from the DB.
- **Profile, contact preferences, saved places:** `get_rider_profile`,
  `save_rider_profile`, `list_saved_places`, `save_place`, `delete_place`. Saved
  places are not yet offered as shortcuts in the request flow.
- **Export:** "Export my data" downloads one JSON document built from
  `get_rider_profile`, `list_saved_places`, `export_ride_requests` (includes the
  stored client record), `export_trips`, `export_trip_transitions`.
- **Deletion:** typing `DELETE` runs `delete_my_rider_data` (every row the rider
  owns, and unlinks `drivers.user_id` if they were a driver on other riders'
  trips; those riders' data stays), then deletes the synced KV copy and local
  rides, then the platform account via the SDK's `deleteAccount`. If the DB step
  fails nothing else is touched. Erasure includes the trip audit history.
- **Anonymous riders:** can request rides without signing in. Those rides live
  only in this browser's localStorage and are never written to the DB; the
  Account page says so. Signing in is the upgrade path: `syncRides()` uploads
  the on-device rides to the account (KV and DB) with no re-entry. Profile,
  saved places, export and deletion require sign-in.

## Driver onboarding and approval (issue #4)

Migration `0004_driver_onboarding`: `driver_applications`, `driver_vehicles`,
`driver_review_log` (append-only audit) and `driver_availability`. These are
keyed by the driver's own PAS user id, not by a rider. Client: `/driver/onboarding`
(`DriverOnboarding.tsx`), `/ops` (`Ops.tsx`), `web/src/lib/driverOnboarding.ts`.

**Application.** Name, phone, licence number/region/expiry and an eligibility
confirmation, plus at least one vehicle (plate, make, model, optional year,
colour, seats). Editable only while `draft` or `rejected`. Licence details are
private: readable only by the applicant (`get_my_driver_application`) and by `ops`;
the ops list shows only the last 4 characters of the licence number (issue #11 tightened this further: a first initial and a masked phone, with full details behind `ops_pii` and a logged reason). Document
images are not collected; only structured data is stored, and nothing is
public. Adding image upload later should use private storage.

**Lifecycle.** `draft → submitted` (applicant, needs every field and a vehicle) →
`approved` or `rejected` (ops; rejected goes back to editable and can be
resubmitted). `approved → suspended → approved` (ops). Rejecting and suspending
require a reason; an invalid move or missing reason changes nothing. Approving
from `submitted` also approves the driver's pending vehicles. Ops cannot review
their own application.

**Vehicles.** `pending → approved | rejected` (ops, `review_driver_vehicle`).
Changing any detail of a vehicle sends it back to `pending`, and takes the
driver off dispatch if it was their active vehicle. Deleting it does the same.

**Audit.** Every submission and decision writes a `driver_review_log` row (from
and to status, reason, actor id, `applicant` or `ops`, time). Applicants read
their own trail; ops read any driver's (`list_driver_review_log`).

**Roles.** The ops actions declare `auth.app_roles: ["ops"]`, enforced by the PAS
action executor before the SQL runs. An app owner must grant it: `app.roles.assign(userId, 'ops')`.
The role check is only the coarse gate; applicant actions are scoped by `:__user_id`
in SQL, and the approval state lives in the DB, so no client-side flag can
grant dispatch.

**Dispatch eligibility.** A driver may be `available` only if their application
is `approved`, their chosen vehicle is `approved`, and their licence has not
expired (checked against `:__now`). `set_driver_availability` refuses otherwise;
going offline always works. `list_dispatchable_drivers` re-checks all of this on
every read, so suspension, rejection, vehicle rejection or licence expiry removes
a driver immediately even if their stored flag is stale. Suspension also clears
the flag, and reinstated drivers must opt in again. Nothing consumes
`list_dispatchable_drivers` yet; matching riders to drivers is a separate piece.

## Driver availability and dispatch (issue #5)

Migration `0005_dispatch`: `driver_locations`, `dispatch_requests`,
`dispatch_offers`. Client: `web/src/lib/dispatch.ts`,
`components/DriverOffers.tsx` (Driver home), and the Availability panel on
`/driver/onboarding`.

**Drivers** go online/offline with `set_driver_availability` (see #4) and publish a
position plus a service radius (0.5-50 km) with `update_driver_location`; the UI
offers 2/5/10/25 km, asks for browser location when going online, and
republishes every minute. Only approved drivers can publish. Going offline
withdraws any open offer.

**Rider flow.** Save the ride (it needs pickup coordinates, `booking_type = now`,
status `open`), call `request_dispatch`, then call `dispatch_tick` every few
seconds while `get_dispatch_status` is `searching` (`runDispatch` does this).
Nothing runs in the background: the rider's ticks drive timeouts and
re-dispatch, and every tick also expires *all* overdue offers so a silent
driver is never stuck.

**Matching** (inside `dispatch_tick`, one deterministic SQL statement). A driver
qualifies if they are online, approved, with an approved vehicle and unexpired
licence, published a location in the last 5 minutes, are within both their own
service radius and 15 km of the pickup, have a vehicle at or above the requested
tier (`share` < `comfort` < `xl`), hold no live offer or assignment, are not the
rider, and have not already been offered this request in this round. The
nearest qualifying driver wins; ties go to the lowest driver id. Distances are
squared km computed in SQL with a cosine series (no `sqrt`/`cos` needed).

**Locks and atomicity.** Two partial unique indexes allow at most one live
(`offered`/`accepted`) offer per driver and per request, so even concurrent
ticks cannot double-book either side; the losing insert is ignored. `accept_offer`
is one transaction guarded by "offer still `offered` and unexpired, driver still
online/approved, request still searching and open"; only then does it create the
rider-side driver, vehicle, assignment and `scheduled` trip (with a transition
row), set the request `matched`, and link `drivers.user_id`, which is what lets
`advance_trip` work. The driver's lock is released when the trip is completed or
cancelled by either side.

**Timeout, decline, no-driver, re-dispatch.** An offer lasts 30 s. Decline or
timeout frees the driver and the next tick offers to the next-nearest driver.
After 3 offers in a round, or 2 minutes, the search becomes `no_driver`; the
rider may call `request_dispatch` again for a fresh round. Cancelling the ride
withdraws offers at any stage.

**Not done.** The rider-facing screens (New ride / Trip) still show the
simulated driver; wiring them to `runDispatch` is a follow-up. Offers reach
drivers by polling (every 5 s), not push. Driver location is not streamed to
the rider through these tables.

## Quotes and the on-demand request flow (issue #6)

Migration `0006_fare_quotes` adds `fare_quotes` (the existing `quotes` table stays
the per-ride accepted-fare record). Client: `web/src/lib/quotes.ts`,
`components/QuotePicker.tsx`, `views/NewRide.tsx`; the Trip screen now follows
real dispatch for these rides.

**Flow (signed-in, "Ride now").** 1) Rider enters pickup and destination; the
client geocodes them and fetches the route (distance, duration). 2) "Get quotes"
calls `create_quote` once per tier (`share`, `comfort`, `xl`; shown as RideShare,
Comfort, RideShare XL). Each card shows eligibility ("N drivers nearby" or
"No drivers nearby"), the fare breakdown and a hold countdown. 3) "Request"
calls `accept_quote`; the app then opens the Trip screen, which ticks dispatch.

**Pricing is server-side.** The client only sends coordinates, labels and the
routed distance/duration; the SQL computes base (200¢), distance (110/160/220¢
per km), time (25/38/50¢ per min), booking fee (150¢), a per-tier minimum
(500/700/900¢, shown as a "minimum fare adjustment"), and a demand surge. Surge
is +0.25x for each other rider still searching within about 5 km beyond the
online drivers within about 10 km, capped at 2.0x. Because the route comes from
the client, the server rejects a distance under 90% of the straight line and
out-of-range values, but cannot prove the route itself; a rider can only
under-report within that bound.

**Eligibility** uses the dispatch rules: online, approved, approved vehicle,
valid licence, fresh location, within radius and 15 km, tier at or above, not
already holding an offer, not the rider.

**Lifecycle.** `pending` for 5 minutes, then `expired` (swept by
`expire_stale_quotes`, `create_quote` and `accept_quote`). A new quote
`superseded`-s the rider's older pending quote for that tier and every pending
quote for a different route. `accept_quote` re-checks, in one transaction: still
pending and unexpired; the coordinates match and the distance is within 10% of
the quote; the surge is unchanged; a driver is still eligible. If any check
fails the quote becomes `expired` or `superseded` and nothing is created. On
success it sets the quote `accepted`, creates the ride request, the accepted
`quotes` row and a `searching` dispatch request in the same transaction (so a
ride never exists without being handed to dispatch), and cannot be replayed for a
second ride.

**Signed-out riders** keep the on-device preview (simulated driver, flat
estimate), now labelled "Preview only". Live quotes and dispatch need an account.

**Not done.** Tolls/wait-time fees; quotes for scheduled and recurring bookings;
driver ETA in the quote (SQLite has no `sqrt` for a distance-based ETA);
server-side geocoding or routing (the platform maps API is called from the client).

## Trip lifecycle and permissions (issue #7)

Migration `0007_trip_lifecycle`: `trip_lifecycle` (one row per trip: start time,
outcome, who cancelled, reason, fee and fee policy), `trip_lifecycle_events`
(append-only: started, completed, cancelled, no_show, fee_waived,
dispute_opened, dispute_resolved) and `trip_disputes`. Client:
`web/src/lib/tripLifecycle.ts`, `views/Trip.tsx` (rider), `views/DriverTrip.tsx`
(driver).

**State machine** (enforced in SQL; `trips.status` keeps its five values and
"in progress" is `status = arrived` with `trip_lifecycle.started_at` set):

`scheduled -> en_route -> arrived -> [start_trip] -> completed`, and
`scheduled | en_route | arrived -> cancelled`. `completed` and `cancelled` are
final. A step out of order, a repeat, or a call by someone not entitled changes
nothing **and writes no audit row**; the call does not fail, so clients re-read
the state (`get_my_trip_lifecycle`, `get_driver_trip`) to confirm. Completing
requires the trip to have been started. A rider can have only one active
on-demand request: `request_dispatch` and `accept_quote` are refused while another
is searching (within its 2 minute window) or matched and unfinished.

**Who can do what** (each action checks the caller against the trip itself):

| Actor | Actions |
|---|---|
| Rider (owns the ride) | `cancel_ride` (before start), `report_driver_no_show`, `open_dispute`, reads |
| Assigned driver (via `drivers.user_id`) | `advance_trip` (en_route, arrived, completed), `start_trip`, `driver_cancel_trip`, `report_rider_no_show`, `open_dispute`, reads |
| Ops (PAS app role `ops`; not the rider or driver of that trip) | `ops_cancel_trip` (any unfinished trip, including one in progress), `ops_resolve_dispute`, `ops_list_disputes`, `ops_get_trip_timeline` |

Once a trip has started the rider and driver can no longer cancel it; only ops can.
A rider "deleting" a finished ride no longer rewrites its history.

**Cancellation reasons, fees and no-shows.** Reason codes are validated per role
(anything else is stored as `other`): rider `changed_plans, wait_too_long,
wrong_pickup, found_other, other`; driver `rider_unreachable, vehicle_issue,
safety, too_far, other`. The fee policy is a hook only (it is recorded, nothing
is charged): rider cancels are free before assignment and within 2 minutes of it;
later 5.00; once the driver has arrived 8.00, always capped at the fare. A driver
cancel costs the rider nothing and is recorded `driver_cancelled`. Driver-reported
rider no-show (after 5 minutes at the pickup): 8.00, outcome `rider_no_show`.
Rider-reported driver no-show (15 minutes after assignment, driver not arrived):
no fee, outcome `driver_no_show`. Ops cancels with a mandatory note and an
optional fee. `preview_cancellation` shows the rider the fee before they confirm.
Each ending is stored in `trip_lifecycle` (`outcome`, `cancelled_by_role`,
`cancel_code`, `cancel_note`, `cancel_fee_cents`, `fee_policy`), in
`trip_lifecycle_events`, and as a `trip_transitions` row with the actor.

**Disputes.** The rider or the assigned driver may dispute a completed or
cancelled trip within 7 days, once each, with a role-specific code. Ops resolve
with `upheld` or `rejected` and a mandatory note; upholding may waive the
cancellation fee (`fee_policy = ops_waived`, a `fee_waived` event). Resolved
disputes are final.

**Simulation removed.** The rider "Preview driver arrival" / "Driver arrived" /
"Trip complete" buttons, the arrival countdown and fake driver, the driver's
"Step +10% (sim)" and sim/real position switch, the "Jordan" demo driver, and the
share-link driver import are gone. Signed-out riders can no longer "ride now"
(they are asked to sign in); reservations and routines still work signed out.
The driver trip screen publishes real GPS only.

**Known gaps.** Fees are recorded but never charged. Ops UI for cancel/dispute
actions is not built (the actions exist and are role-gated). Live position is
covered under *Live tracking* below.

## Live tracking, ETA and location privacy (issue #8)

Migration `0008_trip_locations`: `trip_locations`, one row per trip holding only
the driver's latest position. Client: `web/src/lib/tracking.ts`, `lib/eta.ts`,
`views/Trip.tsx`, `views/DriverTrip.tsx`, `views/TripMap.tsx`. The old
per-ride PAS room and BroadcastChannel transport (unauthenticated, same-browser
or spoofable) is removed; everything goes through authenticated actions.

**Who may send, and when.** `publish_driver_location` accepts a position only
from the driver assigned to the trip, and only while the trip is `en_route` or
`arrived` (which includes in progress). Nothing is accepted while the trip is
`scheduled` (the driver has not started driving) or once it is finished. Other
drivers, the rider and ops are refused. Updates closer than 3 seconds apart are
dropped by the server; the app sends at most one every 4 seconds, always the
newest fix, never a backlog, and warns the driver after 3 failed sends in a row
or when location permission is blocked.

**Plausibility.** Out-of-range coordinates, accuracy worse than 500 m, and
negative or over-70 m/s speeds are dropped.

**Who may see it.** `get_driver_location` returns a row only to the rider who
owns the ride, only while the trip is `en_route`/`arrived`. The driver, other
riders and ops have no read path. The rider's screen only requests it in those
phases.

**Precision and retention.** Coordinates are rounded to 4 decimals (about
11 m) before they are stored. Only the latest position is kept, overwritten in
place; there is no trail or history. It is deleted the moment the trip ends by
completion, rider or driver cancellation, either no-show, or ops cancellation,
and every publish also purges any position older than 24 hours as a backstop.
Account deletion removes it, and a driver's own location data too.

**Cross-device and freshness.** The rider polls every 4 seconds, so it works on
any device. Freshness is the age of the last accepted update, measured by the
server clock when it answered and then aged locally: live (15 s or less),
delayed (up to 60 s), stale (up to 5 min, "last seen N min ago"), offline
(beyond that, the driver is removed from the map). The last known position is
kept on the map while stale.

**ETA.** Recalculated from the driver's current position with the platform
routing service, to the pickup until the rider is on board and to the drop-off
afterwards, and shown only for live or delayed locations. It is refreshed when
the driver moves 150 m or after 30 seconds. If routing is unavailable a
straight-line estimate (about 25 km/h) is shown and labelled approximate. For
stale or offline locations it says the ETA is paused instead of guessing. The
road route from the driver to the next stop is drawn on the map.

**Known gaps.** Polling is not push, so updates can lag by up to a few seconds.
Positions are not map-matched. The data export (#3) does not yet include trip
lifecycle, dispute or live-location data. Driver review-log rows are kept when a
driver deletes their account, for audit.

## Fare ledger and receipts (issue #9)

Migration `0009_fare_ledger`: `fare_statements` (one immutable row per finished trip,
written in the transaction that ends the trip) and `fare_adjustments` (append-only
credits). Client: `lib/receipts.ts`, `components/ReceiptCard.tsx` (rider Trip and
Account pages), driver earnings on `views/DriverTrip.tsx`. The decision record, with
taxes, refunds, payouts, the PAS constraints and the test plan, is
[`docs/adr/0001-fare-collection-payouts-receipts.md`](adr/0001-fare-collection-payouts-receipts.md).

In short: a completed trip costs exactly its accepted quote; a cancelled one costs the
recorded cancellation fee; corrections are ops credits that never exceed the amount;
`ops_reconcile` proves every statement ties to its trip, quote and credits. **No payment
is collected and no payout is made**, and no card or credential data exists anywhere in
the app; collection is blocked on a PAS policy decision (ADR, "Needs an owner decision").

## Notifications (issue #10)

Migration `0010_notifications`: `notifications` (inbox and delivery outbox in one row,
one per recipient per event) and `notification_prefs`. Client: `lib/notifications.ts`,
`lib/useNotifications.ts`, `components/NotificationBell.tsx` (Home and Driver home),
`components/NotificationSettings.tsx` (Account page, which drivers use too).

**Who is told what.** The notification row is written by the same SQL transaction as the
trip event, so it exists exactly once, only for a valid transition, and carries the link to
the right trip (rider `/trip/<ride>`, driver `/driver/trip/<rider>/<ride>`, offers
`/driver`). The person who caused an event is never notified of it.

| Event | Recipient | Critical |
|---|---|---|
| New ride offer (30 s window) | driver | no |
| Driver confirmed (`driver_assigned`, with name and plate) | rider | yes |
| Driver on the way | rider | no |
| Driver arrived | rider | yes |
| Trip started | rider | no |
| Trip completed, receipt ready (with the total) | rider | yes |
| Cancelled (by rider, driver or ops, with reason and fee) | the other party; both for ops | yes |
| Rider no-show / driver no-show | the party reported | yes |
| Dispute decided | whoever opened it | no |

**Idempotent.** Each id is deterministic (`<trip>:<kind>`, `offer:<ride>:<attempt>`,
`<trip>:dispute_resolved:<user>`) and written with `INSERT OR IGNORE`: repeated ticks,
replayed accepts and retried requests never create a second one, and refused transitions
create none.

**Localized.** The row stores a `kind` and JSON parameters, not text. Text is rendered
from a catalogue in English and Spanish in the **reader's** language
(`notification_prefs.locale`); a push is written in the **recipient's** language, which the
delivery list returns with each item.

**Delivery.** The inbox is authoritative and always works (the bell polls every 15 s and
toasts new items). Web push is sent peer-to-peer by the **client of the person whose action
caused it** (`app.notifications.notifyUser`), because the app has no server-side sender. That
client calls `list_pending_deliveries`, sends at most 5 per pass (the platform allows 30 per
minute per sender and 10 per minute per recipient), and reports each result. A push tag
equal to the notification id lets a device collapse a duplicate. The consequence: if the
actor closes the app before delivery, the push waits until they next open it; items undelivered
after 10 minutes are visible to ops (`ops_list_notification_issues`).

**Retry policy** (tested in SQL): up to 3 attempts per channel, the second after 30 s and the
third after 2 minutes; then the delivery is marked `failed` with the error text (100
characters). Reports are accepted only from the actor, only while the delivery is
unfinished, so a late success cannot resurrect a failed one.

**Email and SMS fallback policy.** Explicit and opt-in.
- Email is used only for **critical** kinds, only after push was skipped (the recipient turned
  push off) or failed for good, and only if the recipient ticked the email checkbox in
  Notification settings (consent time recorded; withdrawing clears it and immediately skips
  anything queued). It goes through `notifyUser(..., {channel: 'email'})`: the platform sends
  a fixed template to the verified account address with a one-click unsubscribe, and reports
  `unsubscribed` / `no_address`, which is recorded as skipped and final.
- **SMS is not offered.** The SDK only lets the app's creator send SMS, so the app cannot send
  to riders or drivers; the old "text messages" toggle on the profile was removed.
- Consent is never inferred: the default is email off, and the older profile toggles
  from issue #3 are no longer read.

**Retention and deletion.** A user's notifications older than 30 days are deleted whenever
they mark things read. Account deletion removes their notifications and preferences. The
platform allows a batch action 25 statements at most (the #9 deploy was rejected for it), so
account deletion is now two idempotent actions, `delete_my_rider_data` and
`delete_my_driver_data`; the app calls both.

**Known gaps.** Push needs the browser permission and the actor's client to be running.
Delivery results are only as accurate as the platform's `sent` count. Spanish copy has not
been reviewed by a native speaker. The pending-delivery list is not shown to the recipient.

## Operations console (issue #11)

Route `/ops` (staff only). Migration `0011_ops_console`: `trip_evidence`, `refund_requests`,
`ops_escalations`, `ops_access_log`. Client: `lib/opsConsole.ts`, `views/Ops.tsx` and
`views/ops/*` (tabs: Trips, Drivers, Disputes, Refunds, Escalations, Audit).

**Roles.** Two PAS app roles, granted by the app owner with `app.roles.assign`:
`ops` for the console and every support action, and `ops_pii` for opening personal
details. Holders of `ops_pii` should hold `ops` too. Every ops action is gated by the
platform before its SQL runs, and the SQL also keeps staff out of trips they rode or
drove. Assumption to confirm after deploy: a tool listing one role admits holders of that role.

**Search and inspect (redacted).** `ops_search_trips` finds trips by whole trip id, ride id,
rider id, driver id or receipt number, optionally by status (no partial or fuzzy matching, so
it cannot be used to browse people). `ops_get_trip` shows the phase, who ended the trip and
why, fees, assignment and dispatch status, amounts and dispute/refund counts;
`ops_get_trip_offers` the dispatch chain; `ops_get_trip_timeline` the interleaved history.
None return names, addresses, plates, phone numbers or coordinates.

**Location evidence.** The live position is still deleted when a trip ends (#8). To settle
disputes, up to three **coarse snapshots** (driver arrived, trip started, trip ended; rounded
to about 11 m, taken only from a position under 60 seconds old) are kept for **30 days**
and deleted with the rider's account. Ops see how close the driver was to the pickup (or
the drop-off at the end of a completed trip): within 150 m, 500 m, 2 km, farther, or unknown.
Exact coordinates need `ops_pii` and a logged reason.

**Personal data is role-limited, reasoned and logged.** Names, addresses, plate, exact
coordinates and driver licence details are returned only to `ops_pii`, only after
`ops_log_access` recorded the staff member, scope (`trip_pii`, `evidence`, `driver_pii`),
the target and a reason code (`support_ticket`, `dispute`, `safety_incident`, `fraud_check`,
`legal_request`), and only for 10 minutes afterwards. Every access is in the audit trail. The
driver-application list was redacted too (initial, last 2 phone digits, last 4 licence
characters).

**Support actions all need a reason code and a note:**

| Action | Reason codes | Rules |
|---|---|---|
| Cancel a trip (`ops_cancel_trip`) | safety_incident, rider_request, driver_request, vehicle_issue, fraud_suspected, payment_issue, duplicate_request, other | any unfinished trip, optional capped fee |
| Suspend / reinstate a driver | safety, fraud_suspected, document_expired, repeated_cancellations, complaint, other / review_complete, documents_renewed, error, other | replaces the old suspend path in `review_driver_application`, which no longer suspends; suspension takes the driver off dispatch and withdraws open offers |
| Credit (`ops_credit_trip`) | goodwill, fare_error, duplicate_charge, other | never above the statement amount |
| Request a refund (`ops_request_refund`) | overcharged, service_failure, duplicate_charge, cancel_fee_dispute, other | **a second person decides** (`ops_decide_refund`); records the decision only, no money moves while payments are not enabled (ADR 0001) |
| Escalate (`ops_escalate`) | safety, legal_request, fraud, abuse, regulator_or_press, other | to lead, safety or legal; **someone else resolves it** |
| Resolve a dispute | decision and note, optional fee waiver | (from #7) |

Staff cannot act on their own application, suspension, trips, or requests they made, and
retried submissions are ignored through request keys.

**One audit trail.** `ops_list_audit` returns every staff action newest first with the actor,
time, target, reason code, note and amount: cancellations, fee waivers, dispute decisions,
credits, driver approvals/rejections/suspensions/reinstatements, vehicle decisions, refund
requests and decisions, escalations and resolutions, and every personal-data access. It
reads the append-only logs the actions already write, so no action can skip it. It can be
filtered by trip and by staff member.

**Retention and deletion.** Account deletion removes a rider's evidence snapshots and refund
requests. Escalation records and the personal-data access log are kept as the staff audit
trail (they hold ids, codes and staff notes, not trip content).

**Known gaps.** Staff notes are free text and can contain personal data; staff are told not to
put it there but nothing checks. There is no ticketing, assignment or SLA tracking. Dispute
and refund queues have no search. Executing an approved refund waits on payments (ADR 0001).

## Observability and reliability (issue #15)

Migration `0012_observability`: `client_events` (structured errors, 14 days), `client_metrics`
(per-minute counters), `service_flag_log` (the append-only dispatch pause switch). Client:
`lib/telemetry.ts` (installed in `lib/app.ts`: every platform action is counted, timed and its
failures reported), `views/ops/HealthPanel.tsx`. The whole picture, with the alert thresholds, is in
[`runbooks/README.md`](runbooks/README.md); the retry and idempotency behaviour of every external call
is in [`reliability.md`](reliability.md); the incident procedures are the runbooks for a
[dispatch](runbooks/dispatch-outage.md), [map](runbooks/map-outage.md) and
[notification](runbooks/notification-outage.md) outage and for [rollback](runbooks/rollback.md).

Recorded: seven areas (requests, dispatch, tracking, notifications, payments, maps, trip
transitions). Errors carry only opaque trip/ride ids, action names, status and timings; free text is
redacted and clipped. Alerts are SQL checks over a window: matching failures, offer timeouts, stale and
degraded tracking, inconsistent trip/ride/offer states (critical), rejected trip steps (critical),
failed and undelivered notifications, fare-statement problems, per-area error rate. Health shows
them with a link to the runbook, and the operations switch can pause new ride requests during an outage.
An outside probe (`.github/workflows/health-check.yml`, every 15 minutes) checks the site, the platform,
and that the registered tools match `mcp.json`. **Known gap:** in-app alerts are read on the Health tab;
nothing pages anyone, because the app has no server-side sender.

While adding this, geocoding and routing were found to be calling the Maps API with a plain `fetch`
that carries no session, which the API rejects with 401; they now use the SDK (`app.maps`).

## Migrating legacy rides

Existing rides live in localStorage (`loopride.rides.v2`, which already absorbs
`loopride.rides.v1`) and in per-user KV (`rides.v1`). On every sign-in,
`syncRides()` reconciles local data with KV as before, then calls `save_ride`
for each ride. Every save and delete after that also writes to the DB.

- **No data loss:** each mapped field gets its own column, and the full client
  record (including fields with no column yet, such as `routePolyline`) is
  stored as JSON in `ride_requests.client_record`.
- **Legacy defaults:** a ride without `bookingType` is a pre-RideShare weekly
  routine, so it maps to `booking_type = 'recurring'`. Entities a legacy ride
  never had (quote, vehicle, trip) are not invented.
- **Idempotent:** fixed ids plus upserts mean replaying any ride, or the whole
  list, leaves the database unchanged. Covered by
  `web/src/lib/domainSchema.test.ts`, which runs the committed `migrations.json`
  and `mcp.json` SQL on SQLite, and by `web/src/lib/rideRecords.test.ts`.
- localStorage and KV remain the offline cache and the cross-device sync path.
  The DB is now the system of record that new features should read from.
