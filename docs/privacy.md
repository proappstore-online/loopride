# Privacy: inventory, consent, retention, export and deletion

Issue #13. This page says what personal data Loopride/RideShare keeps, why, for how long, and how a
person gets a copy or has it erased. It describes what the code does. It is not a privacy policy or
legal advice: any period, exemption or entitlement that depends on a jurisdiction is listed under
[Needs a human decision](#needs-a-human-decision) and left as it was.

The inventory is data: [`web/src/lib/privacyInventory.ts`](../web/src/lib/privacyInventory.ts). The test
`web/src/lib/privacy.schema.test.ts` fails if a table is added without an entry, an export decision and
an erasure decision, if an erasure or purge statement disagrees with this page, or if an open legal
question is not listed below.

## Who the data is about

- **Riders** (signed in, or signed out with rides kept only in the browser). They give pickup and
  drop-off addresses by typing or picking them. The app never reads a rider's device location.
- **Drivers** give identity and licence details to be approved, and their precise position while
  available and while driving a trip.
- **Staff** (`ops`, `ops_pii`) see data to run the service and their actions are logged.

## Inventory

| Data class | What it holds | Purpose | Retention | Export | Erasure |
|---|---|---|---|---|---|
| `driver_locations` | A driver's latest position and service radius while available | Match nearby ride requests to available drivers | Driver dispatch positions: 24 hours | `export_driver_records:locations` | `delete_my_driver_data` |
| `trip_locations` | The assigned driver's latest position during a trip (rounded to about 11 m) | Show the rider the driver approaching | Live trip positions: 24 hours | `export_driver_records:locations` | `delete_my_rider_data` |
| `trip_evidence` | Position snapshots at arrival, trip start and trip end | Staff dispute and safety review | Trip evidence snapshots: 30 days | Not exported: Position of the driver captured for dispute handling; whether a subject-access request must include it is a legal question | `delete_my_rider_data` ⚠ needs-human |
| `ride_requests` | Pickup and drop-off addresses and coordinates the rider typed or picked, plus the full client record | Request, match and complete the ride | Until account deletion | `export_ride_requests` | `delete_my_rider_data` |
| `fare_quotes` | Quoted trip: addresses, coordinates, distance, price | Price a trip before it is booked | Until account deletion | `export_rider_records:fare_quotes` | `delete_my_rider_data` |
| `dispatch_requests` | Pickup coordinates of a ride being matched | Find a nearby driver | Until account deletion | `export_rider_records:dispatch_requests` | `delete_my_rider_data` |
| `saved_places` | Named addresses the rider saved | Fill in pickup and drop-off quickly | Until account deletion | `list_saved_places` | `delete_my_rider_data` |
| `riders` | The rider id and timestamps | Own all of the rider's rows | Until account deletion | Not exported: Only the account id (shown as userId in the export) and creation time | `delete_my_rider_data` |
| `rider_profiles` | Name and phone | Show the driver who is riding and reach the rider | Until account deletion | `get_rider_profile` | `delete_my_rider_data` |
| `driver_applications` | Name, phone, licence number, region and expiry, eligibility, review result | Decide whether the person may drive and keep their licence valid | Until account deletion | `get_my_driver_application` | `delete_my_driver_data` ⚠ needs-human |
| `driver_vehicles` | Plate, make, model, year, colour, seats, approval | Approve vehicles and show riders the car | Until account deletion | `list_my_driver_vehicles` | `delete_my_driver_data` |
| `driver_availability` | Whether the driver is available and with which vehicle | Dispatch only to drivers who are online | Until account deletion | `get_my_driver_availability` | `delete_my_driver_data` |
| `drivers` | A driver's display name and rating as recorded on a rider's ride; user_id links to the driver's own account | Show the rider who their driver was | Until account deletion | `export_rider_records:recorded_drivers` | `delete_my_rider_data` |
| `vehicles` | Plate and class as recorded on a rider's ride | Show the rider the car | Until account deletion | `export_rider_records:recorded_vehicles` | `delete_my_rider_data` |
| `quotes` | Legacy quote per ride | Ride history | Until account deletion | `export_rider_records:quotes` | `delete_my_rider_data` |
| `assignments` | Which driver and vehicle took a ride | Ride history and permissions | Until account deletion | `export_rider_records:assignments` | `delete_my_rider_data` |
| `trips` | Trip status | Ride history and the trip lifecycle | Until account deletion | `export_trips` | `delete_my_rider_data` |
| `trip_events` | Legacy status events | Ride history | Until account deletion | Not exported: Superseded by trip_transitions, which is exported and holds the same statuses | `delete_my_rider_data` |
| `trip_transitions` | Every status change with who made it | Authoritative trip history and dispute evidence | Until account deletion | `export_trip_transitions` | `delete_my_rider_data` |
| `trip_lifecycle` | Start, end, cancellation and fee outcome of a trip | Cancellation fees and disputes | Until account deletion | `export_rider_records:trip_lifecycle` | `delete_my_rider_data` |
| `trip_lifecycle_events` | Lifecycle events with the actor and any note | Audit of trip endings | Until account deletion | `export_rider_records:trip_lifecycle_events` | `delete_my_rider_data` |
| `trip_disputes` | Disputes opened by the rider or driver, with notes and the decision | Resolve complaints | Until account deletion | `export_rider_records:disputes` | `delete_my_rider_data` ⚠ needs-human |
| `dispatch_offers` | Offers made to drivers for a ride and their response | Dispatch and its health alerts | Until account deletion | `export_driver_records:offers` | `delete_my_rider_data` ⚠ needs-human |
| `fare_statements` | Receipt: amounts, tax, the driver payout split and route labels | Receipts and earnings | Until account deletion | `export_rider_records:fare_statements` | `delete_my_rider_data` ⚠ needs-human |
| `fare_adjustments` | Credits and refunds against a receipt | Reconcile credits | Until account deletion | `export_rider_records:fare_adjustments` | `delete_my_rider_data` ⚠ needs-human |
| `refund_requests` | Refund requests raised by staff | Two-person refund approval | Until account deletion | `export_rider_records:refund_requests` | `delete_my_rider_data` ⚠ needs-human |
| `notifications` | In-app notification inbox | Tell people about their trips | Notifications: 30 days | `export_account_records:notifications` | `delete_my_rider_data` |
| `notification_prefs` | Language, push and email-fallback choices with the time email consent was given | Respect notification choices | Until account deletion | `export_account_records:notification_prefs` | `delete_my_rider_data` |
| `location_consents` | Which location purposes the person agreed to, the wording version and when | Prove and enforce location consent | Until account deletion | `export_account_records:location_consents` | `delete_my_driver_data` |
| `client_events` | Structured, non-personal error events | Reliability alerts | Diagnostic events: 14 days | `export_account_records:client_events` | `delete_my_driver_data` |
| `client_metrics` | Per-minute call, error and latency counters | Reliability alerts | Diagnostic counters: 14 days | Not exported: Aggregate counters with no content | `delete_my_driver_data` |
| `driver_review_log` | Approval, rejection, suspension decisions with reasons | Audit of driver decisions | Kept after deletion (audit) | `list_my_driver_review_log` | Kept (audit) ⚠ needs-human |
| `ops_access_log` | Who looked at personal data, which scope, and why | Accountability for staff access | Kept after deletion (audit) | Not exported: Staff accountability record; whether a person is entitled to see who accessed their data is a legal question | Kept (audit) ⚠ needs-human |
| `ops_escalations` | Escalations with staff notes | Safety, legal and fraud escalation | Kept after deletion (audit) | Not exported: Staff working records; whether they fall inside a subject-access request is a legal question | Kept (audit) ⚠ needs-human |
| `safety_reports` | Safety reports about the other person on a trip: category, urgency, the reporter's note, trip phase and outcome, staff review and resolution | Safety review, protecting riders and drivers, and proof of how a report was handled | Kept after deletion (audit) | `list_my_safety_reports` | Kept (audit) ⚠ needs-human |
| `safety_report_snapshots` | The addresses, driver name, plate and the driver's last shared position as they were when a safety report was filed | Let staff review a safety report after the live trip data is gone | Safety report snapshots: 30 days | Not exported: A copy of trip addresses and the driver's position taken for staff review; whether a subject-access request must include it is a legal question | `delete_my_rider_data` ⚠ needs-human |
| `rider_block_log` | Every time staff blocked or unblocked a rider, with the reason, note and who did it | Enforce a block so it survives deleting and recreating the account, and account for staff decisions | Kept after deletion (audit) | Not exported: Staff decision record; whether a person is entitled to see or contest a block is a legal question | Kept (audit) ⚠ needs-human |
| `service_flag_log` | Who paused or resumed dispatch, and why | Audit of the dispatch switch | Kept after deletion (audit) | Not exported: Holds only staff actions, no rider or driver data | Kept (audit) |
| `kv:rides.v1` | Synced copy of the rider's rides | Keep rides across devices | Until account deletion | Not exported: The same rides are exported from ride_requests | `delete_my_rider_data` |
| `device:loopride.rides.v2` | Rides stored in this browser, including those made signed out | Ride history without an account | Until account deletion | `onThisDevice.rides` | Cleared by the app |
| `device:loopride.role.v1` | Whether this browser is in rider or driver mode | Open the right home screen | Until account deletion | `onThisDevice.role` | Cleared by the app |
| `device:loopride.retention.v1` | When this browser last asked the server to expire old data | Limit expiry requests to every 6 hours | Until account deletion | Not exported: A timestamp with no personal content | Cleared by the app |


## Precise location and consent

Three kinds of precise location exist:

1. **Addresses and coordinates a rider supplied** (`ride_requests`, `fare_quotes`, `dispatch_requests`,
   `saved_places`). Purpose: to request, price, match and complete the ride they asked for. Kept until
   the account is deleted; the rider can delete a saved place at any time.
2. **A driver's dispatch position** (`driver_locations`), only with the `dispatch_availability` consent.
3. **A driver's live trip position** (`trip_locations`), only with the `trip_tracking` consent.

Consent is recorded server-side in `location_consents` (purpose, whether it is on, the wording version
shown, when it was given or withdrawn). It is enforced by the actions, not just the screens:

| Action | Without consent |
|---|---|
| `update_driver_location` | stores nothing |
| `set_driver_availability` (going available) | the driver stays offline |
| `publish_driver_location` | stores nothing |

Purpose limitation follows from the structure: each consent covers one purpose, the dispatch consent does
not authorise trip tracking or the reverse, dispatch reads `driver_locations` only to match, and
`get_driver_location` returns a trip position only to the rider of that trip, only while the trip is
`en_route` or `arrived`. Staff can see exact coordinates only after `ops_log_access` with a reason code,
for 10 minutes, and the access is in the audit trail.

**Withdrawing** (`set_location_consent` with `granted = 0`, from the Account page or the driver screens)
erases what was collected under that purpose straight away: the dispatch position is deleted, the driver is
taken offline and open offers are cancelled; or the driver's live trip positions are deleted. Going
offline also deletes the dispatch position. A change of notice wording means bumping `NOTICE_VERSION` in
`web/src/lib/privacy.ts`; the screens then ask again. The server checks that a consent exists and is on;
only the app checks the wording version.

The notices shown to drivers (`PURPOSES` in `web/src/lib/privacy.ts`) describe the behaviour above in
plain language. They are not legal terms.

## Retention and deletion schedule

| Class | Rule | Enforced by |
|---|---|---|
| Live trip position (`trip_locations`) | Deleted when the trip ends, however it ends; 24 hours at the latest | trip-ending actions (#8), `purge_expired_data`, withdrawal |
| Driver dispatch position (`driver_locations`) | Deleted when the driver goes offline or withdraws; 24 hours at the latest | `set_driver_availability`, `set_location_consent`, `purge_expired_data` |
| Trip evidence (`trip_evidence`) | 30 days | `purge_expired_data` |
| Safety report snapshots (`safety_report_snapshots`) | 30 days | `purge_expired_data` |
| Notifications (`notifications`) | 30 days | `purge_expired_data`, `mark_notifications_read` |
| Diagnostic events and counters (`client_events`, `client_metrics`) | 14 days | `purge_expired_data`, `report_client_event` |
| Everything else about a person | Until they delete their account | `delete_my_rider_data`, `delete_my_driver_data` |
| Staff audit records (`driver_review_log`, `ops_access_log`, `ops_escalations`, `safety_reports`, `rider_block_log`, `service_flag_log`) | Kept after deletion | not deleted; see below |

`purge_expired_data` deletes expired rows for everyone. Any signed-in client calls it at most every six
hours (`runRetention` in `web/src/lib/privacy.ts`, called from `web/src/App.tsx`), and several actions already purge as they run, so expiry does
not depend on one person's device. The 24-hour window for `driver_locations` and the 14-day window for
`client_metrics` extend rules the project already had for the neighbouring classes (live trip position and
diagnostic events) to classes that previously had none; they are technical windows, not legal ones, and are
on the list below to be confirmed.

Account deletion is two idempotent actions, because the platform limits a batch to 25 statements. The app
runs `delete_my_rider_data` and `delete_my_driver_data`, then clears the key-value copy and this browser's
keys, then removes the platform sign-in. A failure part-way is safe to repeat.

## Export and deletion requests

Both are self-service on the Account page, immediate: **Export my data (JSON)** and **Delete my
account** (type DELETE). Signed-out riders have nothing on the server; their rides are in the browser and
leave with the browser data.

The export (`exportAccountData` in `web/src/lib/riderAccount.ts`) combines the profile, saved places, ride
requests, trips and transitions, the `export_rider_records`, `export_driver_records` and
`export_account_records` actions (one JSON array per section), the driver application, vehicles,
availability, review log, trips and earnings, and what is stored on this device. It is limited to the
caller's own rows and leaves out other people's data: the driver's payout split on a rider's receipt, staff
notes, and disputes opened by someone else.

What deletion leaves behind, and why, is in the inventory (`Kept (audit)`) and the list below. A driver's
deletion does not edit rider-owned trip records: `drivers.user_id` is set to `NULL`, but the driver's
opaque id remains as a reference in `dispatch_offers.driver_id`, `trip_lifecycle_events.actor_id`,
`trip_transitions.actor_id`, `trip_lifecycle.started_by`, `notifications.actor_id`, `trip_disputes.opened_by`
and `fare_statements.driver_user_id` until the rider deletes theirs. A rider's deletion removes the rider's namespace; notifications already delivered to a
driver about that rider's trips stay in the driver's inbox until they expire in 30 days.

## Logs and secrets

Telemetry (`web/src/lib/telemetry.ts`) records opaque ids, action names, status codes and timings only.
Free text is redacted (emails, coordinates, long tokens and phone-like numbers) and clipped to 200
characters, and a test pins that. The repository holds no secrets: CI uses GitHub secrets, and
`web/src/compliance.test.ts` scans the bundle for payment credentials. See
[`security-review.md`](security-review.md).

## Needs a human decision

These are legal or policy choices this change did not make. The code keeps the behaviour that already
existed for each, and the test fails if one is added to the inventory without being listed here.

- `trip_evidence`: Open: whether these snapshots must be part of a subject-access export, and whether 30 days is right for disputes. Staff see exact coordinates only after logging a reason (ops_access_log).
- `driver_applications`: How long to keep a rejected or lapsed applicant's licence details is a legal choice. Staff see licence details only through ops_pii with a logged reason.
- `trip_disputes`: A driver's dispute on a rider's trip is erased with the rider, not the driver; a driver's export covers only disputes the driver opened.
- `dispatch_offers`: Offers sit in the rider's namespace. A driver's own erasure leaves them, pseudonymously, until the rider deletes; whether to anonymise them is open.
- `fare_statements`: ADR 0001 §9: whether tax or accounting law requires keeping statements after an account is deleted is undecided. The ledger is immutable, so a driver's erasure does not edit it.
- `fare_adjustments`: Same open question as fare_statements.
- `refund_requests`: Open: retention of refund records once payments exist (ADR 0001 §9). Staff free-text notes are not exported.
- `driver_review_log`: Documented in docs/domain-model.md as kept for audit. Open: the period, and whether a driver may have the reasons erased.
- `ops_access_log`: Open: how long the access log is kept, and whether an erased person is entitled to see who accessed their data. Today it holds ids, scope and reason code, not trip content.
- `ops_escalations`: Open: how long escalations are kept after the person is erased. Free-text staff notes can contain personal data (docs/domain-model.md known gaps).
- `safety_reports`: Open: how long safety reports are kept, and whether the person reported about may see the report or contest it. Reports are kept after the reporter's account is erased so a report about someone else is not lost (docs/safety.md).
- `safety_report_snapshots`: Open: whether 30 days is right for safety reviews, and whether the snapshot belongs in a subject-access export. Reports referred to authorities may need a longer hold (docs/safety.md).
- `rider_block_log`: Open: how long a block record is kept, whether it may outlive the account, and what appeal route a blocked rider must be offered (docs/safety.md).

Cross-cutting questions:

- **Jurisdiction and legal basis.** Which law applies to which riders and drivers, and what each requires
  for consent wording, access requests, response times and breach notice.
- **Inactive accounts.** Whether data should expire after a period of inactivity. Today nothing does.
- **Minors and age.** Whether riders or drivers need age checks or parental consent is not decided here;
  the app collects no date of birth.
- **Whether the technical windows above** (24 hours, 30 days, 14 days) are acceptable for disputes,
  safety investigations and reliability work.
