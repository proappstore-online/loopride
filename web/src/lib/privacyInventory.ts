/**
 * Privacy inventory (issue #13): every place the app keeps personal data, why, for how long, how
 * it is exported and how it is erased. docs/privacy.md is the readable version; privacy.schema.test.ts
 * checks this file against migrations.json and mcp.json, so a new table or action cannot ship
 * without an entry, an export decision and an erasure decision.
 *
 * Where a period or an exemption is a legal question (tax records, audit trails, what a data-access
 * request must contain), `decision: 'needs-human'` marks it. The code keeps the behaviour that already
 * existed and does not pick a policy.
 */
export type Sensitivity = 'precise_location' | 'identity' | 'contact' | 'trip' | 'financial' | 'preference' | 'diagnostic' | 'staff_audit'

export type Retention =
  /** Deleted by `purge_expired_data` once older than the window (`window` is how the SQL states it). */
  | { rule: 'ttl'; label: string; ms: number; window: string }
  /** Kept until the person deletes their account. This is the existing documented behaviour. */
  | { rule: 'until_deletion' }
  /** Kept after account deletion as a staff audit trail (docs/domain-model.md). */
  | { rule: 'audit' }

export type Erase = 'delete_my_rider_data' | 'delete_my_driver_data' | 'kept_for_audit' | 'device'

export interface DataClass {
  /** The table name, or `device:<key>` / `kv:<key>` for browser and per-user key-value storage. */
  id: string
  holds: string
  subjects: readonly ('rider' | 'driver' | 'staff')[]
  sensitivity: Sensitivity
  purpose: string
  retention: Retention
  /** `action` or `action:section` that exports it, or why it is not part of the person's export. */
  exportedBy: string | { none: string }
  erasedBy: Erase
  /** A legal or jurisdictional choice this code does not make. */
  decision?: 'needs-human'
  note?: string
}

const DAY = 86_400_000

export const DATA_CLASSES: readonly DataClass[] = [
  // ---- precise location ----
  { id: 'driver_locations', holds: "A driver's latest position and service radius while available", subjects: ['driver'], sensitivity: 'precise_location', purpose: 'Match nearby ride requests to available drivers',
    retention: { rule: 'ttl', label: 'Driver dispatch positions', ms: DAY, window: '86400000' }, exportedBy: 'export_driver_records:locations', erasedBy: 'delete_my_driver_data',
    note: 'Also deleted when the driver goes offline or withdraws the dispatch_availability consent. Collected only with that consent.' },
  { id: 'trip_locations', holds: "The assigned driver's latest position during a trip (rounded to about 11 m)", subjects: ['driver', 'rider'], sensitivity: 'precise_location', purpose: 'Show the rider the driver approaching',
    retention: { rule: 'ttl', label: 'Live trip positions', ms: DAY, window: '86400000' }, exportedBy: 'export_driver_records:locations', erasedBy: 'delete_my_rider_data',
    note: "Deleted the moment the trip ends and on withdrawal of the trip_tracking consent. The rider's export leaves it out because it is the driver's position; a driver's erasure deletes it too." },
  { id: 'trip_evidence', holds: 'Position snapshots at arrival, trip start and trip end', subjects: ['driver', 'rider'], sensitivity: 'precise_location', purpose: 'Staff dispute and safety review',
    retention: { rule: 'ttl', label: 'Trip evidence snapshots', ms: 30 * DAY, window: '2592000000' }, exportedBy: { none: "Position of the driver captured for dispute handling; whether a subject-access request must include it is a legal question" }, erasedBy: 'delete_my_rider_data',
    decision: 'needs-human', note: 'Open: whether these snapshots must be part of a subject-access export, and whether 30 days is right for disputes. Staff see exact coordinates only after logging a reason (ops_access_log).' },
  { id: 'ride_requests', holds: 'Pickup and drop-off addresses and coordinates the rider typed or picked, plus the full client record', subjects: ['rider'], sensitivity: 'precise_location', purpose: 'Request, match and complete the ride',
    retention: { rule: 'until_deletion' }, exportedBy: 'export_ride_requests', erasedBy: 'delete_my_rider_data',
    note: 'The app never reads the rider\'s device location; these are addresses the rider supplied.' },
  { id: 'fare_quotes', holds: 'Quoted trip: addresses, coordinates, distance, price', subjects: ['rider'], sensitivity: 'precise_location', purpose: 'Price a trip before it is booked',
    retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:fare_quotes', erasedBy: 'delete_my_rider_data' },
  { id: 'dispatch_requests', holds: 'Pickup coordinates of a ride being matched', subjects: ['rider'], sensitivity: 'precise_location', purpose: 'Find a nearby driver',
    retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:dispatch_requests', erasedBy: 'delete_my_rider_data' },
  { id: 'saved_places', holds: 'Named addresses the rider saved', subjects: ['rider'], sensitivity: 'precise_location', purpose: 'Fill in pickup and drop-off quickly',
    retention: { rule: 'until_deletion' }, exportedBy: 'list_saved_places', erasedBy: 'delete_my_rider_data', note: 'At most 50 per rider; the rider can remove each one.' },
  // ---- identity and contact ----
  { id: 'riders', holds: 'The rider id and timestamps', subjects: ['rider'], sensitivity: 'identity', purpose: 'Own all of the rider\'s rows',
    retention: { rule: 'until_deletion' }, exportedBy: { none: 'Only the account id (shown as userId in the export) and creation time' }, erasedBy: 'delete_my_rider_data' },
  { id: 'rider_profiles', holds: 'Name and phone', subjects: ['rider'], sensitivity: 'contact', purpose: 'Show the driver who is riding and reach the rider',
    retention: { rule: 'until_deletion' }, exportedBy: 'get_rider_profile', erasedBy: 'delete_my_rider_data' },
  { id: 'driver_applications', holds: 'Name, phone, licence number, region and expiry, eligibility, review result', subjects: ['driver'], sensitivity: 'identity', purpose: 'Decide whether the person may drive and keep their licence valid',
    retention: { rule: 'until_deletion' }, exportedBy: 'get_my_driver_application', erasedBy: 'delete_my_driver_data',
    decision: 'needs-human', note: 'How long to keep a rejected or lapsed applicant\'s licence details is a legal choice. Staff see licence details only through ops_pii with a logged reason.' },
  { id: 'driver_vehicles', holds: 'Plate, make, model, year, colour, seats, approval', subjects: ['driver'], sensitivity: 'identity', purpose: 'Approve vehicles and show riders the car',
    retention: { rule: 'until_deletion' }, exportedBy: 'list_my_driver_vehicles', erasedBy: 'delete_my_driver_data' },
  { id: 'driver_availability', holds: 'Whether the driver is available and with which vehicle', subjects: ['driver'], sensitivity: 'preference', purpose: 'Dispatch only to drivers who are online',
    retention: { rule: 'until_deletion' }, exportedBy: 'get_my_driver_availability', erasedBy: 'delete_my_driver_data' },
  { id: 'drivers', holds: "A driver's display name and rating as recorded on a rider's ride; user_id links to the driver's own account", subjects: ['rider', 'driver'], sensitivity: 'identity', purpose: "Show the rider who their driver was",
    retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:recorded_drivers', erasedBy: 'delete_my_rider_data',
    note: "When the driver deletes their account, user_id on these rows is set to NULL, so riders' history keeps the display name but no link to the account." },
  { id: 'vehicles', holds: 'Plate and class as recorded on a rider\'s ride', subjects: ['rider', 'driver'], sensitivity: 'identity', purpose: 'Show the rider the car',
    retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:recorded_vehicles', erasedBy: 'delete_my_rider_data' },
  // ---- trips ----
  { id: 'quotes', holds: 'Legacy quote per ride', subjects: ['rider'], sensitivity: 'trip', purpose: 'Ride history', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:quotes', erasedBy: 'delete_my_rider_data' },
  { id: 'assignments', holds: 'Which driver and vehicle took a ride', subjects: ['rider', 'driver'], sensitivity: 'trip', purpose: 'Ride history and permissions', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:assignments', erasedBy: 'delete_my_rider_data' },
  { id: 'trips', holds: 'Trip status', subjects: ['rider', 'driver'], sensitivity: 'trip', purpose: 'Ride history and the trip lifecycle', retention: { rule: 'until_deletion' }, exportedBy: 'export_trips', erasedBy: 'delete_my_rider_data' },
  { id: 'trip_events', holds: 'Legacy status events', subjects: ['rider'], sensitivity: 'trip', purpose: 'Ride history', retention: { rule: 'until_deletion' }, exportedBy: { none: 'Superseded by trip_transitions, which is exported and holds the same statuses' }, erasedBy: 'delete_my_rider_data' },
  { id: 'trip_transitions', holds: 'Every status change with who made it', subjects: ['rider', 'driver'], sensitivity: 'trip', purpose: 'Authoritative trip history and dispute evidence', retention: { rule: 'until_deletion' }, exportedBy: 'export_trip_transitions', erasedBy: 'delete_my_rider_data' },
  { id: 'trip_lifecycle', holds: 'Start, end, cancellation and fee outcome of a trip', subjects: ['rider', 'driver'], sensitivity: 'trip', purpose: 'Cancellation fees and disputes', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:trip_lifecycle', erasedBy: 'delete_my_rider_data' },
  { id: 'trip_lifecycle_events', holds: 'Lifecycle events with the actor and any note', subjects: ['rider', 'driver', 'staff'], sensitivity: 'trip', purpose: 'Audit of trip endings', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:trip_lifecycle_events', erasedBy: 'delete_my_rider_data' },
  { id: 'trip_disputes', holds: 'Disputes opened by the rider or driver, with notes and the decision', subjects: ['rider', 'driver', 'staff'], sensitivity: 'trip', purpose: 'Resolve complaints', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:disputes', erasedBy: 'delete_my_rider_data', decision: 'needs-human', note: 'A driver\'s dispute on a rider\'s trip is erased with the rider, not the driver; a driver\'s export covers only disputes the driver opened.' },
  { id: 'dispatch_offers', holds: 'Offers made to drivers for a ride and their response', subjects: ['rider', 'driver'], sensitivity: 'trip', purpose: 'Dispatch and its health alerts', retention: { rule: 'until_deletion' }, exportedBy: 'export_driver_records:offers', erasedBy: 'delete_my_rider_data', decision: 'needs-human',
    note: "Offers sit in the rider's namespace. A driver's own erasure leaves them, pseudonymously, until the rider deletes; whether to anonymise them is open." },
  // ---- money ----
  { id: 'fare_statements', holds: 'Receipt: amounts, tax, the driver payout split and route labels', subjects: ['rider', 'driver'], sensitivity: 'financial', purpose: 'Receipts and earnings', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:fare_statements', erasedBy: 'delete_my_rider_data', decision: 'needs-human',
    note: 'ADR 0001 §9: whether tax or accounting law requires keeping statements after an account is deleted is undecided. The ledger is immutable, so a driver\'s erasure does not edit it.' },
  { id: 'fare_adjustments', holds: 'Credits and refunds against a receipt', subjects: ['rider', 'staff'], sensitivity: 'financial', purpose: 'Reconcile credits', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:fare_adjustments', erasedBy: 'delete_my_rider_data', decision: 'needs-human', note: 'Same open question as fare_statements.' },
  { id: 'refund_requests', holds: 'Refund requests raised by staff', subjects: ['rider', 'staff'], sensitivity: 'financial', purpose: 'Two-person refund approval', retention: { rule: 'until_deletion' }, exportedBy: 'export_rider_records:refund_requests', erasedBy: 'delete_my_rider_data', decision: 'needs-human', note: 'Open: retention of refund records once payments exist (ADR 0001 §9). Staff free-text notes are not exported.' },
  // ---- notifications and preferences ----
  { id: 'notifications', holds: 'In-app notification inbox', subjects: ['rider', 'driver'], sensitivity: 'trip', purpose: 'Tell people about their trips',
    retention: { rule: 'ttl', label: 'Notifications', ms: 30 * DAY, window: '2592000000' }, exportedBy: 'export_account_records:notifications', erasedBy: 'delete_my_rider_data' },
  { id: 'notification_prefs', holds: 'Language, push and email-fallback choices with the time email consent was given', subjects: ['rider', 'driver'], sensitivity: 'preference', purpose: 'Respect notification choices', retention: { rule: 'until_deletion' }, exportedBy: 'export_account_records:notification_prefs', erasedBy: 'delete_my_rider_data' },
  { id: 'location_consents', holds: 'Which location purposes the person agreed to, the wording version and when', subjects: ['driver'], sensitivity: 'preference', purpose: 'Prove and enforce location consent', retention: { rule: 'until_deletion' }, exportedBy: 'export_account_records:location_consents', erasedBy: 'delete_my_driver_data',
    note: 'Erased with the account, so proof of consent does not outlive it.' },
  // ---- diagnostics ----
  { id: 'client_events', holds: 'Structured, non-personal error events', subjects: ['rider', 'driver'], sensitivity: 'diagnostic', purpose: 'Reliability alerts',
    retention: { rule: 'ttl', label: 'Diagnostic events', ms: 14 * DAY, window: '1209600000' }, exportedBy: 'export_account_records:client_events', erasedBy: 'delete_my_driver_data' },
  { id: 'client_metrics', holds: 'Per-minute call, error and latency counters', subjects: ['rider', 'driver'], sensitivity: 'diagnostic', purpose: 'Reliability alerts',
    retention: { rule: 'ttl', label: 'Diagnostic counters', ms: 14 * DAY, window: '20160' }, exportedBy: { none: 'Aggregate counters with no content' }, erasedBy: 'delete_my_driver_data' },
  // ---- staff records kept for audit ----
  { id: 'driver_review_log', holds: 'Approval, rejection, suspension decisions with reasons', subjects: ['driver', 'staff'], sensitivity: 'staff_audit', purpose: 'Audit of driver decisions', retention: { rule: 'audit' }, exportedBy: 'list_my_driver_review_log', erasedBy: 'kept_for_audit', decision: 'needs-human', note: 'Documented in docs/domain-model.md as kept for audit. Open: the period, and whether a driver may have the reasons erased.' },
  { id: 'ops_access_log', holds: 'Who looked at personal data, which scope, and why', subjects: ['staff', 'rider', 'driver'], sensitivity: 'staff_audit', purpose: 'Accountability for staff access', retention: { rule: 'audit' }, exportedBy: { none: 'Staff accountability record; whether a person is entitled to see who accessed their data is a legal question' }, erasedBy: 'kept_for_audit', decision: 'needs-human', note: 'Open: how long the access log is kept, and whether an erased person is entitled to see who accessed their data. Today it holds ids, scope and reason code, not trip content.' },
  { id: 'ops_escalations', holds: 'Escalations with staff notes', subjects: ['staff', 'rider', 'driver'], sensitivity: 'staff_audit', purpose: 'Safety, legal and fraud escalation', retention: { rule: 'audit' }, exportedBy: { none: 'Staff working records; whether they fall inside a subject-access request is a legal question' }, erasedBy: 'kept_for_audit', decision: 'needs-human', note: 'Open: how long escalations are kept after the person is erased. Free-text staff notes can contain personal data (docs/domain-model.md known gaps).' },
  { id: 'safety_reports', holds: 'Safety reports a rider or driver filed about the other person on a trip: category, urgency, their note, the trip phase and outcome, and the staff review and resolution', subjects: ['rider', 'driver', 'staff'], sensitivity: 'staff_audit', purpose: 'Safety review, protecting riders and drivers, and proof of how a report was handled', retention: { rule: 'audit' },
    exportedBy: 'list_my_safety_reports', erasedBy: 'kept_for_audit', decision: 'needs-human',
    note: "Kept after the reporter's account is deleted so a report about someone else is not lost. Open: how long, and whether the person reported about may see the report. The reporter's own export lists their reports, without staff notes. Holds ids and the reporter's free text but no addresses, names, plates or coordinates (those live in safety_report_snapshots)." },
  { id: 'safety_report_snapshots', holds: "The addresses, driver name, plate and the driver's last shared position as they were when a safety report was filed", subjects: ['rider', 'driver'], sensitivity: 'precise_location', purpose: 'Let staff review a safety report after the live trip data is gone',
    retention: { rule: 'ttl', label: 'Safety report snapshots', ms: 30 * DAY, window: '2592000000' }, exportedBy: { none: "A copy of trip addresses and the driver's position taken for staff review; whether a subject-access request must include it is a legal question" }, erasedBy: 'delete_my_rider_data',
    decision: 'needs-human', note: 'Open: whether 30 days is right for safety reviews (a longer window may be needed for reports referred to authorities), and whether these must be part of a subject-access export. Staff see them only after logging a reason (ops_access_log); the position needs a separate evidence-scope log.' },
  { id: 'rider_block_log', holds: 'Every time staff blocked or unblocked a rider, with the reason, note and who did it', subjects: ['rider', 'staff'], sensitivity: 'staff_audit', purpose: 'Enforce a block so it survives deleting and recreating the account, and account for staff decisions', retention: { rule: 'audit' },
    exportedBy: { none: 'Staff decision record; whether a person is entitled to see or contest a block is a legal question' }, erasedBy: 'kept_for_audit', decision: 'needs-human',
    note: 'Open: how long a block record is kept, whether it may outlive the account, and what appeal route a blocked rider must be offered. Until decided it is kept so a block cannot be dodged by recreating the account.' },
  { id: 'service_flag_log', holds: 'Who paused or resumed dispatch, and why', subjects: ['staff'], sensitivity: 'staff_audit', purpose: 'Audit of the dispatch switch', retention: { rule: 'audit' }, exportedBy: { none: 'Holds only staff actions, no rider or driver data' }, erasedBy: 'kept_for_audit' },
  // ---- on the device and in per-user key-value storage ----
  { id: 'kv:rides.v1', holds: 'Synced copy of the rider\'s rides', subjects: ['rider'], sensitivity: 'precise_location', purpose: 'Keep rides across devices', retention: { rule: 'until_deletion' }, exportedBy: { none: 'The same rides are exported from ride_requests' }, erasedBy: 'delete_my_rider_data', note: 'Deleted by the app when the account is erased (eraseRiderData).' },
  { id: 'device:loopride.rides.v2', holds: 'Rides stored in this browser, including those made signed out', subjects: ['rider'], sensitivity: 'precise_location', purpose: 'Ride history without an account', retention: { rule: 'until_deletion' }, exportedBy: 'onThisDevice.rides', erasedBy: 'device', note: 'Cleared on account erasure; signed-out riders clear it with their browser data.' },
  { id: 'device:loopride.role.v1', holds: 'Whether this browser is in rider or driver mode', subjects: ['rider', 'driver'], sensitivity: 'preference', purpose: 'Open the right home screen', retention: { rule: 'until_deletion' }, exportedBy: 'onThisDevice.role', erasedBy: 'device' },
  { id: 'device:loopride.retention.v1', holds: 'When this browser last asked the server to expire old data', subjects: ['rider', 'driver'], sensitivity: 'diagnostic', purpose: 'Limit expiry requests to every 6 hours', retention: { rule: 'until_deletion' }, exportedBy: { none: 'A timestamp with no personal content' }, erasedBy: 'device' },
]

const humanPeriod = (ms: number) => (ms >= 2 * DAY ? `${Math.round(ms / DAY)} days` : '24 hours')

/** The short-lived data classes and their periods, for the Account page. One line per distinct label. */
export const RETENTION_SUMMARY: readonly string[] = [
  ...new Set(
    DATA_CLASSES.flatMap((c) => (c.retention.rule === 'ttl' ? [`${c.retention.label}: ${humanPeriod(c.retention.ms)}`] : [])),
  ),
]
