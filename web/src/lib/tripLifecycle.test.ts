import { beforeEach, describe, expect, it, vi } from 'vitest'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions, auth: { user: { id: 'u1' } } } }))

import {
  DRIVER_NO_SHOW_WAIT_MS,
  RIDER_NO_SHOW_WAIT_MS,
  canReportDriverNoShow,
  canReportRiderNoShow,
  canRiderCancel,
  cancelRide,
  currentUserId,
  driverCancel,
  driverStep,
  isFinished,
  loadDriverTrip,
  loadRiderTrip,
  nextDriverStep,
  noShowWaitLeftMs,
  openDispute,
  previewCancellation,
  reportRiderNoShow,
  type Phase,
} from './tripLifecycle'

beforeEach(() => actions.call.mockReset())

const row = (extra = {}) => ({ trip_id: 't1', request_id: 'r1', phase: 'en_route', started_at: null, ended_at: null, outcome: null, cancelled_by_role: null, cancel_code: null, cancel_fee_cents: 0, fee_policy: null, assigned_at: 100, disputed: 0, ...extra })

describe('phase rules mirror the server', () => {
  it('the driver is only ever offered the next legal step', () => {
    expect((['scheduled', 'en_route', 'arrived', 'in_progress', 'completed', 'cancelled'] as Phase[]).map((p) => nextDriverStep(p)?.run ?? null)).toEqual(['en_route', 'arrived', 'start', 'completed', null, null])
  })

  it('the rider can cancel only before the trip starts', () => {
    expect((['scheduled', 'en_route', 'arrived', 'in_progress', 'completed', 'cancelled'] as Phase[]).map(canRiderCancel)).toEqual([true, true, true, false, false, false])
    expect(isFinished('completed') && isFinished('cancelled') && !isFinished('arrived')).toBe(true)
  })

  it('no-show reports unlock after the waiting periods', () => {
    expect(canReportRiderNoShow({ phase: 'arrived', arrivedAt: 0 }, RIDER_NO_SHOW_WAIT_MS - 1)).toBe(false)
    expect(canReportRiderNoShow({ phase: 'arrived', arrivedAt: 0 }, RIDER_NO_SHOW_WAIT_MS)).toBe(true)
    expect(canReportRiderNoShow({ phase: 'in_progress', arrivedAt: 0 }, 10 * RIDER_NO_SHOW_WAIT_MS)).toBe(false)
    expect(canReportDriverNoShow({ phase: 'en_route', assignedAt: 0 }, DRIVER_NO_SHOW_WAIT_MS - 1)).toBe(false)
    expect(canReportDriverNoShow({ phase: 'scheduled', assignedAt: 0 }, DRIVER_NO_SHOW_WAIT_MS)).toBe(true)
    expect(canReportDriverNoShow({ phase: 'arrived', assignedAt: 0 }, 10 * DRIVER_NO_SHOW_WAIT_MS)).toBe(false)
    expect(noShowWaitLeftMs({ arrivedAt: 1000 }, 1000 + 60_000)).toBe(RIDER_NO_SHOW_WAIT_MS - 60_000)
    expect(noShowWaitLeftMs({ arrivedAt: 0 }, 99 * RIDER_NO_SHOW_WAIT_MS)).toBe(0)
  })
})

describe('calls', () => {
  it('maps the rider trip and previews the cancellation fee', async () => {
    actions.call.mockResolvedValueOnce([row({ phase: 'cancelled', outcome: 'rider_cancelled', cancel_fee_cents: 500, disputed: 1 })])
    expect(await loadRiderTrip('r1')).toMatchObject({ tripId: 't1', phase: 'cancelled', outcome: 'rider_cancelled', cancelFeeCents: 500, disputed: true, assignedAt: 100 })
    expect(actions.call).toHaveBeenCalledWith('get_my_trip_lifecycle', { request_id: 'r1' })
    actions.call.mockResolvedValueOnce([])
    expect(await loadRiderTrip('r1')).toBeNull()
    actions.call.mockResolvedValueOnce([{ fee_cents: 800, policy: 'arrived_cancel' }])
    expect(await previewCancellation('r1')).toEqual({ feeCents: 800, policy: 'arrived_cancel' })
    actions.call.mockResolvedValueOnce([])
    expect(await previewCancellation('r1')).toEqual({ feeCents: 0, policy: 'none' })
  })

  it('maps the driver trip with coordinates and the arrival time', async () => {
    actions.call.mockResolvedValueOnce([row({ arrived_at: 7, pickup_label: 'A', dropoff_label: 'B', pickup_lat: 1, pickup_lng: 2, dropoff_lat: null, dropoff_lng: null })])
    expect(await loadDriverTrip('rider', 't1')).toMatchObject({ arrivedAt: 7, pickup: 'A', pickupCoord: { lat: 1, lng: 2 }, dropoffCoord: null })
    expect(actions.call).toHaveBeenCalledWith('get_driver_trip', { rider_id: 'rider', trip_id: 't1' })
  })

  it('uses the server action and parameter names for each role', async () => {
    await cancelRide('r1', 'wrong_pickup', '  note ')
    expect(actions.call).toHaveBeenLastCalledWith('cancel_ride', { request_id: 'r1', reason_code: 'wrong_pickup', note: 'note' })
    await driverStep('start', 'rider', 't1')
    expect(actions.call).toHaveBeenLastCalledWith('start_trip', { rider_id: 'rider', trip_id: 't1' })
    await driverStep('completed', 'rider', 't1')
    expect(actions.call).toHaveBeenLastCalledWith('advance_trip', { rider_id: 'rider', trip_id: 't1', to_status: 'completed' })
    await driverCancel('rider', 't1', 'safety')
    expect(actions.call).toHaveBeenLastCalledWith('driver_cancel_trip', { rider_id: 'rider', trip_id: 't1', reason_code: 'safety', note: null })
    await reportRiderNoShow('rider', 't1')
    expect(actions.call).toHaveBeenLastCalledWith('report_rider_no_show', { rider_id: 'rider', trip_id: 't1', note: null })
    await openDispute('rider', 't1', 'cancel_fee', 'unfair')
    expect(actions.call).toHaveBeenLastCalledWith('open_dispute', { rider_id: 'rider', trip_id: 't1', reason_code: 'cancel_fee', note: 'unfair' })
    expect(currentUserId()).toBe('u1')
  })
})
