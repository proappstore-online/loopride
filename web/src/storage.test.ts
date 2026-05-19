import { describe, expect, it } from 'vitest'
import type { RecurringRide } from './types'
import { deleteRide, getRide, listRides, saveRide } from './storage'

const ride = (overrides: Partial<RecurringRide> = {}): RecurringRide => ({
  id: crypto.randomUUID(),
  pickup: 'Home',
  pickupCoord: { lat: -33.8688, lng: 151.2093 },
  dropoff: 'School',
  dropoffCoord: { lat: -33.857, lng: 151.215 },
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  time: '08:00',
  driverName: 'Alex',
  paused: false,
  createdAt: Date.now(),
  ...overrides,
})

describe('storage', () => {
  it('returns [] when empty', () => {
    expect(listRides()).toEqual([])
  })

  it('saves a new ride and lists it', () => {
    const r = ride()
    saveRide(r)
    expect(listRides()).toEqual([r])
  })

  it('prepends new rides so newest is first', () => {
    const first = ride({ pickup: 'First' })
    const second = ride({ pickup: 'Second' })
    saveRide(first)
    saveRide(second)
    expect(listRides().map((x) => x.pickup)).toEqual(['Second', 'First'])
  })

  it('updates an existing ride in place when ids match', () => {
    const r = ride({ pickup: 'Home' })
    saveRide(r)
    saveRide({ ...r, pickup: 'Renamed' })
    const all = listRides()
    expect(all).toHaveLength(1)
    expect(all[0]?.pickup).toBe('Renamed')
  })

  it('getRide returns the matching ride or undefined', () => {
    const r = ride()
    saveRide(r)
    expect(getRide(r.id)).toEqual(r)
    expect(getRide('missing')).toBeUndefined()
  })

  it('deleteRide removes only the targeted ride', () => {
    const r1 = ride()
    const r2 = ride()
    saveRide(r1)
    saveRide(r2)
    deleteRide(r1.id)
    expect(listRides().map((x) => x.id)).toEqual([r2.id])
  })

  it('listRides recovers from corrupt JSON in localStorage', () => {
    localStorage.setItem('loopride.rides.v1', '{not json')
    expect(listRides()).toEqual([])
  })
})
