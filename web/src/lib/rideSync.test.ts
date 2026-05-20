import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RecurringRide } from '../types'

const { authState, kv } = vi.hoisted(() => ({
  authState: { token: null as string | null, user: null as { id: string } | null },
  kv: {
    get: vi.fn(),
    set: vi.fn(),
  },
}))

vi.mock('./app', () => ({
  app: {
    auth: {
      get token() {
        return authState.token
      },
      get user() {
        return authState.user
      },
      onChange: vi.fn(() => () => undefined),
    },
    kv,
  },
}))

const ride = (id: string): RecurringRide => ({
  id,
  pickup: 'A',
  pickupCoord: null,
  dropoff: 'B',
  dropoffCoord: null,
  days: ['mon'],
  time: '08:00',
  driverName: 'Alex',
  paused: false,
  createdAt: 1,
})

const LOCAL_KEY = 'loopride.rides.v2'
const OWNER_KEY = 'loopride.rides.owner.v1'

beforeEach(() => {
  authState.token = null
  authState.user = null
  kv.get.mockReset()
  kv.set.mockReset()
  localStorage.clear()
})

describe('syncRides', () => {
  it('no-ops when signed out', async () => {
    const { syncRides } = await import('./rideSync')
    await syncRides()
    expect(kv.get).not.toHaveBeenCalled()
    expect(kv.set).not.toHaveBeenCalled()
  })

  it('adopts remote rides when remote has data', async () => {
    authState.token = 'jwt'
    authState.user = { id: 'user-1' }
    kv.get.mockResolvedValueOnce([ride('remote-a'), ride('remote-b')])
    const { syncRides } = await import('./rideSync')
    await syncRides()
    const local = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]')
    expect(local.map((r: RecurringRide) => r.id)).toEqual(['remote-a', 'remote-b'])
    expect(localStorage.getItem(OWNER_KEY)).toBe('user-1')
    expect(kv.set).not.toHaveBeenCalled()
  })

  it('pushes local rides when remote is empty', async () => {
    authState.token = 'jwt'
    authState.user = { id: 'user-1' }
    localStorage.setItem(LOCAL_KEY, JSON.stringify([ride('local-x')]))
    kv.get.mockResolvedValueOnce(null)
    const { syncRides } = await import('./rideSync')
    await syncRides()
    expect(kv.set).toHaveBeenCalledWith('rides.v1', [expect.objectContaining({ id: 'local-x' })])
    expect(localStorage.getItem(OWNER_KEY)).toBe('user-1')
  })

  it('no-ops when both empty', async () => {
    authState.token = 'jwt'
    authState.user = { id: 'user-1' }
    kv.get.mockResolvedValueOnce(null)
    const { syncRides } = await import('./rideSync')
    await syncRides()
    expect(kv.set).not.toHaveBeenCalled()
  })

  it('clears local rides when a different user signs in (SEC-1)', async () => {
    authState.token = 'jwt'
    authState.user = { id: 'user-B' }
    // Local belongs to user-A from a previous session.
    localStorage.setItem(LOCAL_KEY, JSON.stringify([ride('leaked')]))
    localStorage.setItem(OWNER_KEY, 'user-A')
    kv.get.mockResolvedValueOnce(null)
    const { syncRides } = await import('./rideSync')
    await syncRides()
    // user-A's leaked ride must NOT have been pushed to user-B's KV.
    expect(kv.set).not.toHaveBeenCalled()
    // Local was cleared before reconciliation.
    expect(localStorage.getItem(LOCAL_KEY)).toBeNull()
    expect(localStorage.getItem(OWNER_KEY)).toBe('user-B')
  })

  it('swallows KV errors silently', async () => {
    authState.token = 'jwt'
    authState.user = { id: 'user-1' }
    kv.get.mockRejectedValueOnce(new Error('network'))
    const { syncRides } = await import('./rideSync')
    await expect(syncRides()).resolves.toBeUndefined()
  })
})

describe('pushRides', () => {
  it('no-ops when signed out', async () => {
    const { pushRides } = await import('./rideSync')
    pushRides([ride('a')])
    expect(kv.set).not.toHaveBeenCalled()
  })

  it('fires kv.set when signed in', async () => {
    authState.token = 'jwt'
    kv.set.mockResolvedValueOnce(undefined)
    const { pushRides } = await import('./rideSync')
    pushRides([ride('a')])
    expect(kv.set).toHaveBeenCalledWith('rides.v1', [expect.objectContaining({ id: 'a' })])
  })
})
