import { app } from './app'

/**
 * Trip lifecycle client. The server (mcp.json) owns every transition,
 * permission, fee and timeout; these wrappers call the role's actions and read
 * the authoritative state back. A refused action changes nothing, so callers
 * confirm by re-reading rather than trusting the call to throw.
 * See docs/domain-model.md › Trip lifecycle and permissions.
 */
export type Phase = 'scheduled' | 'en_route' | 'arrived' | 'in_progress' | 'completed' | 'cancelled'
export type Outcome = 'completed' | 'rider_cancelled' | 'driver_cancelled' | 'rider_no_show' | 'driver_no_show' | 'ops_cancelled'

export interface TripState {
  tripId: string
  requestId: string
  phase: Phase
  startedAt: number | null
  endedAt: number | null
  outcome: Outcome | null
  cancelledByRole: 'rider' | 'driver' | 'ops' | null
  cancelCode: string | null
  cancelFeeCents: number
  feePolicy: string | null
  assignedAt: number | null
  arrivedAt: number | null
  disputed: boolean
  pickup: string | null
  dropoff: string | null
}

interface Row {
  trip_id: string
  request_id: string
  phase: Phase
  started_at: number | null
  ended_at: number | null
  outcome: Outcome | null
  cancelled_by_role: 'rider' | 'driver' | 'ops' | null
  cancel_code: string | null
  cancel_fee_cents: number
  fee_policy: string | null
  assigned_at: number | null
  arrived_at?: number | null
  disputed: number
  pickup_label?: string
  dropoff_label?: string
}

/** The signed-in user's id; as a rider this is the `rider_id` the server scopes their trips by. */
export const currentUserId = () => app.auth.user?.id

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

const fromRow = (r: Row): TripState => ({
  tripId: r.trip_id,
  requestId: r.request_id,
  phase: r.phase,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  outcome: r.outcome,
  cancelledByRole: r.cancelled_by_role,
  cancelCode: r.cancel_code,
  cancelFeeCents: r.cancel_fee_cents,
  feePolicy: r.fee_policy,
  assignedAt: r.assigned_at,
  arrivedAt: r.arrived_at ?? null,
  disputed: r.disputed === 1,
  pickup: r.pickup_label ?? null,
  dropoff: r.dropoff_label ?? null,
})

// ---- reason lists (the server normalises anything else to "other") ----
export const RIDER_CANCEL_REASONS = [
  { code: 'changed_plans', label: 'My plans changed' },
  { code: 'wait_too_long', label: 'The wait is too long' },
  { code: 'wrong_pickup', label: 'Wrong pickup location' },
  { code: 'found_other', label: 'I found another ride' },
  { code: 'other', label: 'Something else' },
] as const
export const DRIVER_CANCEL_REASONS = [
  { code: 'rider_unreachable', label: "Can't reach the rider" },
  { code: 'vehicle_issue', label: 'Vehicle problem' },
  { code: 'safety', label: 'Safety concern' },
  { code: 'too_far', label: 'Pickup too far' },
  { code: 'other', label: 'Something else' },
] as const
export const RIDER_DISPUTE_REASONS = [
  { code: 'overcharged', label: 'I was overcharged' },
  { code: 'route', label: 'The route was wrong' },
  { code: 'driver_conduct', label: 'Driver conduct' },
  { code: 'cancel_fee', label: 'Cancellation fee' },
  { code: 'other', label: 'Something else' },
] as const
export const DRIVER_DISPUTE_REASONS = [
  { code: 'rider_conduct', label: 'Rider conduct' },
  { code: 'cancel_fee', label: 'Cancellation fee' },
  { code: 'damage', label: 'Vehicle damage' },
  { code: 'other', label: 'Something else' },
] as const

// ---- waiting periods (mirrors the server, which is what enforces them) ----
export const RIDER_NO_SHOW_WAIT_MS = 5 * 60_000
export const DRIVER_NO_SHOW_WAIT_MS = 15 * 60_000

export const isFinished = (phase: Phase) => phase === 'completed' || phase === 'cancelled'
export const canRiderCancel = (phase: Phase) => phase === 'scheduled' || phase === 'en_route' || phase === 'arrived'
export const canReportDriverNoShow = (t: Pick<TripState, 'phase' | 'assignedAt'>, now = Date.now()) =>
  (t.phase === 'scheduled' || t.phase === 'en_route') && t.assignedAt != null && now - t.assignedAt >= DRIVER_NO_SHOW_WAIT_MS
export const canReportRiderNoShow = (t: Pick<TripState, 'phase' | 'arrivedAt'>, now = Date.now()) =>
  t.phase === 'arrived' && t.arrivedAt != null && now - t.arrivedAt >= RIDER_NO_SHOW_WAIT_MS
export const noShowWaitLeftMs = (t: Pick<TripState, 'arrivedAt'>, now = Date.now()) =>
  t.arrivedAt == null ? RIDER_NO_SHOW_WAIT_MS : Math.max(0, RIDER_NO_SHOW_WAIT_MS - (now - t.arrivedAt))

/** The next step a driver can take, in the only order the server allows. */
export function nextDriverStep(phase: Phase): { label: string; run: 'en_route' | 'arrived' | 'start' | 'completed' } | null {
  switch (phase) {
    case 'scheduled': return { label: 'Start driving to pickup', run: 'en_route' }
    case 'en_route': return { label: "I've arrived", run: 'arrived' }
    case 'arrived': return { label: 'Start trip', run: 'start' }
    case 'in_progress': return { label: 'Complete trip', run: 'completed' }
    default: return null
  }
}

export const OUTCOME_TEXT: Record<Outcome, string> = {
  completed: 'Trip completed',
  rider_cancelled: 'You cancelled this ride',
  driver_cancelled: 'The driver cancelled this ride',
  rider_no_show: 'Cancelled: no one met the driver at pickup',
  driver_no_show: 'Cancelled: the driver did not arrive',
  ops_cancelled: 'Cancelled by support',
}

// ---- rider ----
export async function loadRiderTrip(requestId: string): Promise<TripState | null> {
  const [row] = await call<Row[]>('get_my_trip_lifecycle', { request_id: requestId })
  return row ? fromRow(row) : null
}

/** What cancelling would cost right now. No assigned trip means free. */
export async function previewCancellation(requestId: string): Promise<{ feeCents: number; policy: string }> {
  const [row] = await call<{ fee_cents: number; policy: string }[]>('preview_cancellation', { request_id: requestId })
  return row ? { feeCents: row.fee_cents, policy: row.policy } : { feeCents: 0, policy: 'none' }
}

export const cancelRide = (requestId: string, reasonCode: string, note?: string) =>
  call('cancel_ride', { request_id: requestId, reason_code: reasonCode, note: note?.trim() || null })
export const reportDriverNoShow = (requestId: string, note?: string) => call('report_driver_no_show', { request_id: requestId, note: note?.trim() || null })

// ---- driver ----
export async function loadDriverTrip(riderId: string, tripId: string): Promise<(TripState & { pickupCoord: { lat: number; lng: number } | null; dropoffCoord: { lat: number; lng: number } | null }) | null> {
  const [row] = await call<(Row & { pickup_lat: number | null; pickup_lng: number | null; dropoff_lat: number | null; dropoff_lng: number | null })[]>('get_driver_trip', { rider_id: riderId, trip_id: tripId })
  if (!row) return null
  return {
    ...fromRow(row),
    pickupCoord: row.pickup_lat != null && row.pickup_lng != null ? { lat: row.pickup_lat, lng: row.pickup_lng } : null,
    dropoffCoord: row.dropoff_lat != null && row.dropoff_lng != null ? { lat: row.dropoff_lat, lng: row.dropoff_lng } : null,
  }
}

export function driverStep(step: NonNullable<ReturnType<typeof nextDriverStep>>['run'], riderId: string, tripId: string) {
  if (step === 'start') return call('start_trip', { rider_id: riderId, trip_id: tripId })
  return call('advance_trip', { rider_id: riderId, trip_id: tripId, to_status: step })
}
export const driverCancel = (riderId: string, tripId: string, reasonCode: string, note?: string) =>
  call('driver_cancel_trip', { rider_id: riderId, trip_id: tripId, reason_code: reasonCode, note: note?.trim() || null })
export const reportRiderNoShow = (riderId: string, tripId: string, note?: string) =>
  call('report_rider_no_show', { rider_id: riderId, trip_id: tripId, note: note?.trim() || null })

// ---- both ----
export const openDispute = (riderId: string, tripId: string, reasonCode: string, note?: string) =>
  call('open_dispute', { rider_id: riderId, trip_id: tripId, reason_code: reasonCode, note: note?.trim() || null })
