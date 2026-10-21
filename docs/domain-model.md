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
the ops list shows just the last 4 characters of the licence number. Document
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
