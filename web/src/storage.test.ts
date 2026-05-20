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
    localStorage.setItem('loopride.rides.v2', '{not json')
    expect(listRides()).toEqual([])
  })

  it('migrates v1 → v2 storage key on first read', () => {
    const r = ride()
    localStorage.setItem('loopride.rides.v1', JSON.stringify([r]))
    // v2 starts empty.
    expect(localStorage.getItem('loopride.rides.v2')).toBeNull()
    expect(listRides()).toEqual([r])
    // After migration, v1 is gone and v2 holds the data.
    expect(localStorage.getItem('loopride.rides.v1')).toBeNull()
    expect(JSON.parse(localStorage.getItem('loopride.rides.v2') ?? '[]')).toEqual([r])
  })

  it('migration does not overwrite existing v2 data', () => {
    const v1 = ride({ pickup: 'old' })
    const v2 = ride({ pickup: 'new' })
    localStorage.setItem('loopride.rides.v1', JSON.stringify([v1]))
    localStorage.setItem('loopride.rides.v2', JSON.stringify([v2]))
    expect(listRides().map((r) => r.pickup)).toEqual(['new'])
    expect(localStorage.getItem('loopride.rides.v1')).toBeNull()
  })
})
