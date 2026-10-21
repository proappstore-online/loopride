import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecurringRide } from '../types'

const { actions, kv } = vi.hoisted(() => ({
  actions: { call: vi.fn() },
  kv: { delete: vi.fn() },
}))

vi.mock('./app', () => ({ app: { actions, kv, auth: { user: { id: 'u1' } } } }))

import {
  bucketForLocalRide,
  bucketForRow,
  eraseRiderData,
  exportAccountData,
  groupHistory,
  loadHistory,
  loadProfile,
  saveProfile,
  DEFAULT_PROFILE,
} from './riderAccount'
import { listRides, saveRide } from '../storage'

beforeEach(() => {
  actions.call.mockReset()
  kv.delete.mockReset()
})

const row = (booking_type: 'now' | 'scheduled' | 'recurring', status: string, trip_status: string | null = null) =>
  ({ booking_type, status, trip_status }) as Parameters<typeof bucketForRow>[0]

describe('trip grouping', () => {
  it('puts DB ride requests in active, scheduled, completed and cancelled', () => {
    expect(bucketForRow(row('now', 'matched', 'en_route'))).toBe('active')
    expect(bucketForRow(row('now', 'open'))).toBe('active')
    expect(bucketForRow(row('scheduled', 'matched'))).toBe('scheduled')
    expect(bucketForRow(row('recurring', 'paused'))).toBe('scheduled')
    expect(bucketForRow(row('scheduled', 'matched', 'en_route'))).toBe('active')
    expect(bucketForRow(row('now', 'completed', 'completed'))).toBe('completed')
    expect(bucketForRow(row('recurring', 'open', 'completed'))).toBe('completed')
    expect(bucketForRow(row('now', 'cancelled'))).toBe('cancelled')
    expect(bucketForRow(row('now', 'matched', 'cancelled'))).toBe('cancelled')
  })

  it('groups local rides the same way', () => {
    const base: RecurringRide = { id: 'a', pickup: 'A', pickupCoord: null, dropoff: 'B', dropoffCoord: null, days: [], time: '08:00', driverName: '', paused: false, createdAt: 1 }
    expect(bucketForLocalRide({ ...base, bookingType: 'now' })).toBe('active')
    expect(bucketForLocalRide({ ...base, bookingType: 'now', status: 'arrived' })).toBe('active')
    expect(bucketForLocalRide({ ...base, bookingType: 'now', status: 'completed' })).toBe('completed')
    expect(bucketForLocalRide({ ...base, bookingType: 'scheduled' })).toBe('scheduled')
    expect(bucketForLocalRide(base)).toBe('scheduled') // legacy record = weekly routine
  })

  it('loadHistory maps rows and groupHistory buckets them', async () => {
    actions.call.mockResolvedValueOnce([
      { id: 'r1', booking_type: 'now', status: 'cancelled', pickup_label: 'A', dropoff_label: 'B', trip_status: null, fare_cents: 900, updated_at: 5 },
      { id: 'r2', booking_type: 'scheduled', status: 'open', pickup_label: 'C', dropoff_label: 'D', trip_status: null, fare_cents: null, updated_at: 4 },
    ])
    const groups = groupHistory(await loadHistory())
    expect(actions.call).toHaveBeenCalledWith('list_trip_history', { limit: 200 })
    expect(groups.cancelled.map((i) => i.id)).toEqual(['r1'])
    expect(groups.scheduled[0]).toMatchObject({ id: 'r2', dropoff: 'D', fareCents: null })
    expect(groups.active).toEqual([])
  })
})

describe('profile', () => {
  it('defaults when no row exists', async () => {
    actions.call.mockResolvedValueOnce([])
    expect(await loadProfile()).toEqual(DEFAULT_PROFILE)
  })

  it('maps stored preferences', async () => {
    actions.call.mockResolvedValueOnce([{ display_name: 'Sam', phone: null, notify_email: 0, notify_sms: 1, notify_trip_updates: 1 }])
    expect(await loadProfile()).toEqual({ displayName: 'Sam', phone: '', notifyEmail: false, notifySms: true, notifyTripUpdates: true })
  })

  it('saves trimmed values and 0/1 flags', async () => {
    await saveProfile({ displayName: '  Sam ', phone: '', notifyEmail: true, notifySms: false, notifyTripUpdates: false })
    expect(actions.call).toHaveBeenCalledWith('save_rider_profile', {
      display_name: 'Sam',
      phone: null,
      notify_email: 1,
      notify_sms: 0,
      notify_trip_updates: 0,
    })
  })
})

describe('export and deletion', () => {
  it('export bundles every rider-owned dataset', async () => {
    actions.call.mockImplementation(async (name: string) => [name])
    const data = await exportAccountData()
    expect(data).toMatchObject({
      userId: 'u1',
      profile: ['get_rider_profile'],
      savedPlaces: ['list_saved_places'],
      rideRequests: ['export_ride_requests'],
      trips: ['export_trips'],
      tripTransitions: ['export_trip_transitions'],
    })
  })

  it('erase deletes DB rows, the KV copy and local rides', async () => {
    saveRide({ id: 'a', pickup: 'A', pickupCoord: null, dropoff: 'B', dropoffCoord: null, days: [], time: '08:00', driverName: '', paused: false, createdAt: 1 })
    actions.call.mockResolvedValue(undefined)
    await eraseRiderData()
    expect(actions.call).toHaveBeenCalledWith('delete_my_rider_data', {})
    expect(kv.delete).toHaveBeenCalledWith('rides.v1')
    expect(listRides()).toEqual([])
  })

  it('does not wipe local data when the DB deletion fails', async () => {
    saveRide({ id: 'a', pickup: 'A', pickupCoord: null, dropoff: 'B', dropoffCoord: null, days: [], time: '08:00', driverName: '', paused: false, createdAt: 1 })
    actions.call.mockRejectedValue(new Error('boom'))
    await expect(eraseRiderData()).rejects.toThrow()
    expect(kv.delete).not.toHaveBeenCalled()
    expect(listRides()).toHaveLength(1)
  })
})
