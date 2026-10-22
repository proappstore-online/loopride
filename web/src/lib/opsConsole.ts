import { app } from './app'

/**
 * Operations console client. Every rule (roles, reason codes, four-eyes, audit,
 * redaction, logged personal-data access) is enforced by the actions in
 * mcp.json; this file names the reason codes the actions accept and wraps the
 * calls. See docs/domain-model.md › Operations console.
 */
export interface Reason { code: string; label: string }

export const CANCEL_REASONS: Reason[] = [
  { code: 'safety_incident', label: 'Safety incident' },
  { code: 'rider_request', label: 'Rider asked us to' },
  { code: 'driver_request', label: 'Driver asked us to' },
  { code: 'vehicle_issue', label: 'Vehicle issue' },
  { code: 'fraud_suspected', label: 'Suspected fraud' },
  { code: 'payment_issue', label: 'Payment issue' },
  { code: 'duplicate_request', label: 'Duplicate request' },
  { code: 'other', label: 'Other' },
]
export const SUSPEND_REASONS: Reason[] = [
  { code: 'safety', label: 'Safety' },
  { code: 'fraud_suspected', label: 'Suspected fraud' },
  { code: 'document_expired', label: 'Document expired' },
  { code: 'repeated_cancellations', label: 'Repeated cancellations' },
  { code: 'complaint', label: 'Complaint' },
  { code: 'other', label: 'Other' },
]
export const REINSTATE_REASONS: Reason[] = [
  { code: 'review_complete', label: 'Review complete' },
  { code: 'documents_renewed', label: 'Documents renewed' },
  { code: 'error', label: 'Suspended in error' },
  { code: 'other', label: 'Other' },
]
export const REFUND_REASONS: Reason[] = [
  { code: 'overcharged', label: 'Overcharged' },
  { code: 'service_failure', label: 'Service failure' },
  { code: 'duplicate_charge', label: 'Duplicate charge' },
  { code: 'cancel_fee_dispute', label: 'Cancellation fee dispute' },
  { code: 'other', label: 'Other' },
]
export const CREDIT_REASONS: Reason[] = [
  { code: 'goodwill', label: 'Goodwill' },
  { code: 'fare_error', label: 'Fare error' },
  { code: 'duplicate_charge', label: 'Duplicate charge' },
  { code: 'other', label: 'Other' },
]
export const ESCALATE_REASONS: Reason[] = [
  { code: 'safety', label: 'Safety' },
  { code: 'legal_request', label: 'Legal request' },
  { code: 'fraud', label: 'Fraud' },
  { code: 'abuse', label: 'Abuse' },
  { code: 'regulator_or_press', label: 'Regulator or press' },
  { code: 'other', label: 'Other' },
]
export const ESCALATE_LEVELS = [
  { code: 'lead', label: 'Team lead' },
  { code: 'safety', label: 'Safety team' },
  { code: 'legal', label: 'Legal' },
] as const
export const ACCESS_REASONS: Reason[] = [
  { code: 'support_ticket', label: 'Support ticket' },
  { code: 'dispute', label: 'Dispute' },
  { code: 'safety_incident', label: 'Safety incident' },
  { code: 'fraud_check', label: 'Fraud check' },
  { code: 'legal_request', label: 'Legal request' },
]

export const reasonLabel = (list: Reason[], code: string | null) => list.find((r) => r.code === code)?.label ?? code ?? ''

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)
/** A key the server uses to ignore a repeated submission. */
export const newKey = () => crypto.randomUUID()

export async function hasRole(role: 'ops' | 'ops_pii'): Promise<boolean> {
  try {
    return await app.roles.check(role)
  } catch {
    return false
  }
}

// ---- trips ----
export interface TripSummary {
  trip_id: string
  request_id: string
  rider_id: string
  driver_user_id: string | null
  phase: string
  outcome: string | null
  vehicle_class: string | null
  created_at: number
  updated_at: number
  final_cents: number | null
  dispatch_status: string | null
  dispute_open: number
}
export const searchTrips = (q: string, status: string) => call<TripSummary[]>('ops_search_trips', { q: q.trim() || null, status: status || null, limit: 50 })

export interface TripDetail extends TripSummary {
  status: string
  started_at: number | null
  ended_at: number | null
  cancelled_by_role: string | null
  cancel_code: string | null
  cancel_fee_cents: number | null
  fee_policy: string | null
  booking_type: string
  assignment_status: string | null
  dispatch_attempts: number | null
  receipt_no: string | null
  credits_cents: number
  disputes: number
  disputes_open: number
  refund_requests: number
}
export async function getTrip(riderId: string, tripId: string): Promise<TripDetail | null> {
  const [row] = await call<TripDetail[]>('ops_get_trip', { rider_id: riderId, trip_id: tripId })
  return row ?? null
}
export interface Offer { attempt: number; driver_user_id: string; status: string; distance_km2: number | null; offered_at: number; responded_at: number | null }
export const getOffers = (riderId: string, requestId: string) => call<Offer[]>('ops_get_trip_offers', { rider_id: riderId, request_id: requestId })
export interface TimelineEntry { kind: 'transition' | 'event'; name: string; actor: string; detail: string; at: number }
export const getTimeline = (riderId: string, tripId: string) => call<TimelineEntry[]>('ops_get_trip_timeline', { rider_id: riderId, trip_id: tripId })
export interface EvidencePoint { kind: 'arrived' | 'started' | 'ended'; captured_at: number; age_ms: number; accuracy_m: number | null; proximity: string }
export const getEvidence = (riderId: string, tripId: string) => call<EvidencePoint[]>('ops_get_trip_evidence', { rider_id: riderId, trip_id: tripId })

export const PROXIMITY_TEXT: Record<string, string> = {
  within_150m: 'within 150 m',
  within_500m: 'within 500 m',
  within_2km: 'within 2 km',
  farther: 'more than 2 km away',
  unknown: 'unknown',
}

// ---- personal data (ops_pii): the reason is logged first, then the data is read ----
export interface TripPii { trip_id: string; pickup_label: string; dropoff_label: string; rider_name: string | null; driver_name: string | null; plate: string | null }
export interface EvidencePii { kind: string; lat: number; lng: number; accuracy_m: number | null; captured_at: number }

export async function revealTrip(riderId: string, tripId: string, reasonCode: string): Promise<TripPii | null> {
  await call('ops_log_access', { scope: 'trip_pii', rider_id: riderId, trip_id: tripId, driver_user_id: null, reason_code: reasonCode })
  const [row] = await call<TripPii[]>('ops_get_trip_pii', { rider_id: riderId, trip_id: tripId })
  return row ?? null
}
export async function revealEvidence(riderId: string, tripId: string, reasonCode: string): Promise<EvidencePii[]> {
  await call('ops_log_access', { scope: 'evidence', rider_id: riderId, trip_id: tripId, driver_user_id: null, reason_code: reasonCode })
  return call<EvidencePii[]>('ops_get_trip_evidence_pii', { rider_id: riderId, trip_id: tripId })
}
export interface DriverPii { user_id: string; full_name: string; phone: string; licence_number: string; licence_region: string; licence_expires: string }
export async function revealDriver(driverUserId: string, reasonCode: string): Promise<DriverPii | null> {
  await call('ops_log_access', { scope: 'driver_pii', rider_id: null, trip_id: null, driver_user_id: driverUserId, reason_code: reasonCode })
  const [row] = await call<DriverPii[]>('get_driver_application_detail', { driver_user_id: driverUserId })
  return row ?? null
}

// ---- actions ----
export const cancelTrip = (riderId: string, tripId: string, reasonCode: string, note: string, feeCents: number) =>
  call('ops_cancel_trip', { rider_id: riderId, trip_id: tripId, reason_code: reasonCode, note: note.trim(), fee_cents: Math.max(0, Math.round(feeCents)) })
export const creditTrip = (riderId: string, tripId: string, amountCents: number, reasonCode: string, note: string) =>
  call('ops_credit_trip', { rider_id: riderId, trip_id: tripId, request_key: newKey(), amount_cents: Math.round(amountCents), reason_code: reasonCode, note: note.trim() })
export const requestRefund = (riderId: string, tripId: string, amountCents: number, reasonCode: string, note: string) =>
  call('ops_request_refund', { rider_id: riderId, trip_id: tripId, request_key: newKey(), amount_cents: Math.round(amountCents), reason_code: reasonCode, note: note.trim() })
export const escalate = (target: { riderId?: string; tripId?: string; driverUserId?: string }, level: string, reasonCode: string, note: string) =>
  call('ops_escalate', { request_key: newKey(), rider_id: target.riderId ?? null, trip_id: target.tripId ?? null, driver_user_id: target.driverUserId ?? null, level, reason_code: reasonCode, note: note.trim() })
export const suspendDriver = (driverUserId: string, reasonCode: string, note: string) => call('ops_suspend_driver', { driver_user_id: driverUserId, reason_code: reasonCode, note: note.trim() })
export const reinstateDriver = (driverUserId: string, reasonCode: string, note: string) => call('ops_reinstate_driver', { driver_user_id: driverUserId, reason_code: reasonCode, note: note.trim() })

// ---- queues ----
export interface Dispute { rider_id: string; trip_id: string; opened_by: string; opened_role: string; reason_code: string; note: string | null; status: string; opened_at: number; outcome: string | null; cancel_fee_cents: number | null }
export const listDisputes = () => call<Dispute[]>('ops_list_disputes', { status: null, limit: 50 })
export const resolveDispute = (d: Pick<Dispute, 'rider_id' | 'trip_id' | 'opened_by'>, decision: 'upheld' | 'rejected', note: string, waiveFee: boolean) =>
  call('ops_resolve_dispute', { rider_id: d.rider_id, trip_id: d.trip_id, opened_by: d.opened_by, decision, note: note.trim(), waive_fee: waiveFee ? 1 : 0 })

export interface RefundRequest { rider_id: string; request_key: string; trip_id: string; amount_cents: number; reason_code: string; note: string; status: string; requested_by: string; requested_at: number }
export const listRefunds = () => call<RefundRequest[]>('ops_list_refund_requests', { status: null, limit: 50 })
export const decideRefund = (r: Pick<RefundRequest, 'rider_id' | 'request_key'>, decision: 'approved' | 'rejected', note: string) =>
  call('ops_decide_refund', { rider_id: r.rider_id, request_key: r.request_key, decision, note: note.trim() })

export interface Escalation { id: string; rider_id: string | null; trip_id: string | null; driver_user_id: string | null; level: string; reason_code: string; note: string; status: string; opened_by: string; opened_at: number }
export const listEscalations = () => call<Escalation[]>('ops_list_escalations', { status: null, limit: 50 })
export const resolveEscalation = (id: string, note: string) => call('ops_resolve_escalation', { request_key: id, note: note.trim() })

export interface AuditEntry { at: number; action: string; actor_id: string; rider_id: string | null; trip_id: string | null; driver_user_id: string | null; reason_code: string | null; note: string | null; amount_cents: number | null }
export const listAudit = (tripId: string, actor: string) => call<AuditEntry[]>('ops_list_audit', { trip_id: tripId.trim() || null, actor: actor.trim() || null, limit: 100 })

// ---- safety reports and rider blocks (issue #12) ----
export const BLOCK_REASONS: Reason[] = [
  { code: 'safety', label: 'Safety' },
  { code: 'abuse', label: 'Abuse' },
  { code: 'fraud_suspected', label: 'Suspected fraud' },
  { code: 'other', label: 'Other' },
]
export const UNBLOCK_REASONS: Reason[] = [
  { code: 'review_complete', label: 'Review complete' },
  { code: 'appeal_upheld', label: 'Appeal upheld' },
  { code: 'error', label: 'Blocked in error' },
  { code: 'other', label: 'Other' },
]
export const SAFETY_RESOLUTIONS: Reason[] = [
  { code: 'no_action', label: 'No action needed' },
  { code: 'warned', label: 'Person warned' },
  { code: 'driver_suspended', label: 'Driver suspended' },
  { code: 'rider_blocked', label: 'Rider blocked' },
  { code: 'referred_externally', label: 'Referred to an outside body' },
  { code: 'unable_to_substantiate', label: 'Could not substantiate' },
  { code: 'duplicate', label: 'Duplicate report' },
]
export interface SafetyReport {
  id: string; rider_id: string; trip_id: string; reporter_id: string; reporter_role: 'rider' | 'driver'; subject_id: string | null; subject_role: 'rider' | 'driver' | null
  category: string; urgency: 'urgent' | 'standard'; note: string | null; trip_phase: string; trip_outcome: string | null; vehicle_class: string | null
  status: 'open' | 'in_review' | 'resolved'; created_at: number; acknowledged_by: string | null; acknowledged_at: number | null; resolved_by: string | null; resolved_at: number | null; resolution_code: string | null; resolution_note: string | null
}
export const listSafetyReports = (status: string | null = null) => call<SafetyReport[]>('ops_list_safety_reports', { status, limit: 100 })
export const acknowledgeSafetyReport = (id: string) => call('ops_update_safety_report', { report_id: id, status: 'in_review', resolution_code: null, note: null })
export const resolveSafetyReport = (id: string, resolutionCode: string, note: string) => call('ops_update_safety_report', { report_id: id, status: 'resolved', resolution_code: resolutionCode, note: note.trim() })
export interface SafetyPii { report_id: string; pickup_label: string | null; dropoff_label: string | null; driver_name: string | null; plate: string | null; lat: number | null; lng: number | null; accuracy_m: number | null; position_at: number | null; captured_at: number }
/** Logs the reason for names and addresses and for coordinates, then reads the snapshot kept with the report. */
export async function revealSafetyReport(r: Pick<SafetyReport, 'id' | 'rider_id' | 'trip_id'>, reasonCode: string, withPosition: boolean): Promise<SafetyPii | null> {
  await call('ops_log_access', { scope: 'trip_pii', rider_id: r.rider_id, trip_id: r.trip_id, driver_user_id: null, reason_code: reasonCode })
  if (withPosition) await call('ops_log_access', { scope: 'evidence', rider_id: r.rider_id, trip_id: r.trip_id, driver_user_id: null, reason_code: reasonCode })
  const [row] = await call<SafetyPii[]>('ops_get_safety_report_pii', { report_id: r.id })
  return row ?? null
}
export interface RiderBlock { rider_id: string; reason_code: string; note: string; report_id: string | null; actor_id: string; at: number }
export const listRiderBlocks = () => call<RiderBlock[]>('ops_list_rider_blocks', { limit: 100 })
export const blockRider = (riderUserId: string, reasonCode: string, note: string, reportId: string | null) =>
  call('ops_block_rider', { rider_user_id: riderUserId, reason_code: reasonCode, note: note.trim(), report_id: reportId })
export const liftRiderBlock = (riderUserId: string, reasonCode: string, note: string) =>
  call('ops_lift_rider_block', { rider_user_id: riderUserId, reason_code: reasonCode, note: note.trim() })

// ---- health ----
export interface HealthAlert { code: string; domain: string; severity: 'critical' | 'warning'; firing: number; value: number; threshold: string; message: string; runbook: string }
export interface HealthMetric { domain: string; calls: number; errors: number; slow: number; avg_latency_ms: number; people: number; gauge_a: number | null; gauge_b: number | null }
export interface Invariant { ref: string; code: string; detail: string }
export interface ErrorGroup { domain: string; code: string; severity: string; n: number; people: number; last_at: number; sample_trip: string | null; action: string | null; status: number | null }

export const loadAlerts = (windowMin: number) => call<HealthAlert[]>('ops_health_alerts', { window_min: windowMin })
export const loadMetrics = (windowMin: number) => call<HealthMetric[]>('ops_health_metrics', { window_min: windowMin })
export const loadInvariants = () => call<Invariant[]>('ops_health_invariants', { limit: 100 })
export const loadErrors = (windowMin: number) => call<ErrorGroup[]>('ops_health_errors', { window_min: windowMin, domain: null })

export const PAUSE_REASONS: Reason[] = [
  { code: 'dispatch_outage', label: 'Dispatch outage' },
  { code: 'maintenance', label: 'Maintenance' },
  { code: 'incident', label: 'Incident' },
]
export const setDispatchPaused = (paused: boolean, reasonCode: string, note: string) =>
  call('ops_set_service_flag', { name: 'dispatch', paused: paused ? 1 : 0, reason_code: paused ? reasonCode : 'resolved', note: note.trim() })
export async function isDispatchPaused(): Promise<boolean> {
  const [row] = await call<{ dispatch_paused: number }[]>('get_service_status')
  return row?.dispatch_paused === 1
}

/** Where the runbooks live (rendered by GitHub). */
export const RUNBOOK_URL = (name: string) => `https://github.com/proappstore-online/loopride/blob/main/docs/runbooks/${name}.md`
