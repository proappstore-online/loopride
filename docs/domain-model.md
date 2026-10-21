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
