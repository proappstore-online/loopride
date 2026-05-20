import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RecurringRide } from '../types'

const { authState, kv } = vi.hoisted(() => ({
  authState: { token: null as string | null },
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

const LOCAL_KEY = 'loopride.rides.v1'

beforeEach(() => {
  authState.token = null
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
    kv.get.mockResolvedValueOnce([ride('remote-a'), ride('remote-b')])
    const { syncRides } = await import('./rideSync')
    await syncRides()
    const local = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]')
    expect(local.map((r: RecurringRide) => r.id)).toEqual(['remote-a', 'remote-b'])
    expect(kv.set).not.toHaveBeenCalled()
  })

  it('pushes local rides when remote is empty', async () => {
    authState.token = 'jwt'
    localStorage.setItem(LOCAL_KEY, JSON.stringify([ride('local-x')]))
    kv.get.mockResolvedValueOnce(null)
    const { syncRides } = await import('./rideSync')
    await syncRides()
    expect(kv.set).toHaveBeenCalledWith('rides.v1', [expect.objectContaining({ id: 'local-x' })])
  })

  it('no-ops when both empty', async () => {
    authState.token = 'jwt'
    kv.get.mockResolvedValueOnce(null)
    const { syncRides } = await import('./rideSync')
    await syncRides()
    expect(kv.set).not.toHaveBeenCalled()
  })

  it('swallows KV errors silently', async () => {
    authState.token = 'jwt'
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
