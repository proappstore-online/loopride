import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecurringRide } from '../types'

const { authState, kv, actions } = vi.hoisted(() => ({
  authState: { user: null as { id: string } | null },
  kv: { get: vi.fn(), set: vi.fn() },
  actions: { call: vi.fn() },
}))

vi.mock('./app', () => ({
  app: {
    auth: {
      get user() {
        return authState.user
      },
      onChange: vi.fn(() => () => undefined),
    },
    kv,
    actions,
  },
}))

const { deleteRide, saveRide } = await import('../storage')
const { syncRides } = await import('./rideSync')
const { rideToRecords } = await import('./rideRecords')

const ride = (id: string, overrides: Partial<RecurringRide> = {}): RecurringRide => ({
  id,
  pickup: 'Home',
  pickupCoord: null,
  dropoff: 'School',
  dropoffCoord: null,
  days: ['mon'],
  time: '08:00',
  driverName: 'Alex',
  paused: false,
  createdAt: 1,
  ...overrides,
})

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  authState.user = null
  kv.get.mockReset().mockResolvedValue(null)
  kv.set.mockReset().mockResolvedValue(undefined)
  actions.call.mockReset().mockResolvedValue({ results: [] })
})

describe('ride records → PAS DB', () => {
  it('does not touch the DB when signed out', async () => {
    saveRide(ride('r1'))
    deleteRide('r1')
    await flush()
    expect(actions.call).not.toHaveBeenCalled()
  })

  it('persists saves and soft-cancels deletes when signed in', async () => {
    authState.user = { id: 'u1' }
    const r = ride('r1')
    saveRide(r)
    deleteRide('r1')
    await flush()
    expect(actions.call).toHaveBeenNthCalledWith(1, 'save_ride', rideToRecords(r))
    expect(actions.call).toHaveBeenNthCalledWith(2, 'cancel_ride', { request_id: 'r1' })
  })

  it('a DB failure leaves the local save intact', async () => {
    authState.user = { id: 'u1' }
    actions.call.mockRejectedValue(new Error('offline'))
    saveRide(ride('r1'))
    await flush()
    expect(JSON.parse(localStorage.getItem('loopride.rides.v2')!)).toHaveLength(1)
  })

  it('sign-in migrates legacy v1 local rides into the DB, idempotently', async () => {
    const legacy = [ride('a'), ride('b', { driverName: '' })]
    localStorage.setItem('loopride.rides.v1', JSON.stringify(legacy))
    authState.user = { id: 'u1' }

    await syncRides()
    const firstRun = actions.call.mock.calls.map((c) => [...c])
    expect(firstRun).toEqual([
      ['save_ride', rideToRecords(legacy[0])],
      ['save_ride', rideToRecords(legacy[1])],
    ])

    actions.call.mockClear()
    kv.get.mockResolvedValue(legacy) // KV now holds what the first sync pushed
    await syncRides()
    expect(actions.call.mock.calls).toEqual(firstRun)
  })

  it('sign-in migrates KV rides from another device', async () => {
    const remote = [ride('k1', { paused: true })]
    kv.get.mockResolvedValue(remote)
    authState.user = { id: 'u1' }
    await syncRides()
    expect(actions.call).toHaveBeenCalledWith('save_ride', rideToRecords(remote[0]))
    expect(rideToRecords(remote[0]).request_status).toBe('paused')
  })
})
