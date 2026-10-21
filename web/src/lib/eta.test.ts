import { describe, expect, it, vi } from 'vitest'
import { DELAYED_MS, LIVE_MS, RECOMPUTE_EVERY_MS, RECOMPUTE_MOVED_M, STALE_MS, computeEta, distanceM, etaTarget, etaTrusted, formatEta, freshness, shouldRecompute } from './eta'

const A = { lat: -33.8688, lng: 151.2093 }
const B = { lat: -33.8688 + 0.009, lng: 151.2093 } // about 1 km north

describe('freshness', () => {
  it('classifies the age of the last accepted update', () => {
    expect([0, LIVE_MS, LIVE_MS + 1, DELAYED_MS, DELAYED_MS + 1, STALE_MS, STALE_MS + 1].map(freshness)).toEqual(['live', 'live', 'delayed', 'delayed', 'stale', 'stale', 'offline'])
  })

  it('only live and delayed locations are trusted for an ETA', () => {
    expect((['live', 'delayed', 'stale', 'offline'] as const).map(etaTrusted)).toEqual([true, true, false, false])
  })
})

describe('distance and targets', () => {
  it('computes great-circle distance', () => {
    expect(distanceM(A, A)).toBe(0)
    expect(distanceM(A, B)).toBeGreaterThan(990)
    expect(distanceM(A, B)).toBeLessThan(1010)
  })

  it('heads to the pickup until the rider is on board, then the drop-off, and nowhere else', () => {
    const pickup = { lat: 1, lng: 1 }
    const dropoff = { lat: 2, lng: 2 }
    expect(['scheduled', 'en_route', 'arrived', 'in_progress', 'completed', 'cancelled'].map((p) => etaTarget(p, pickup, dropoff))).toEqual([pickup, pickup, null, dropoff, null, null])
    expect(etaTarget('en_route', null, dropoff)).toBeNull()
  })
})

describe('shouldRecompute', () => {
  const last = { from: A, target: B, at: 1000 }

  it('asks again on first use, a new target, enough movement, or an old answer', () => {
    expect(shouldRecompute(null, A, B, 1000)).toBe(true)
    expect(shouldRecompute(last, A, { lat: 5, lng: 5 }, 1001)).toBe(true)
    expect(shouldRecompute(last, { lat: A.lat + (RECOMPUTE_MOVED_M + 20) / 111_000, lng: A.lng }, B, 1001)).toBe(true)
    expect(shouldRecompute(last, A, B, 1000 + RECOMPUTE_EVERY_MS)).toBe(true)
  })

  it('leaves a fresh answer alone while the driver has barely moved', () => {
    expect(shouldRecompute(last, { lat: A.lat + 0.0003, lng: A.lng }, B, 1000 + RECOMPUTE_EVERY_MS - 1)).toBe(false)
  })
})

describe('computeEta', () => {
  it('uses current route data from the driver position', async () => {
    const route = vi.fn(async () => ({ coordinates: [[1, 2], [3, 4]] as [number, number][], distanceMeters: 1500, durationSeconds: 240 }))
    const eta = await computeEta(A, B, route)
    expect(route).toHaveBeenCalledWith(A, B, undefined)
    expect(eta).toEqual({ seconds: 240, distanceM: 1500, approximate: false, polyline: [[1, 2], [3, 4]] })
  })

  it('falls back to a labelled straight-line estimate when routing fails', async () => {
    const eta = await computeEta(A, B, vi.fn(async () => { throw new Error('down') }))
    expect(eta.approximate).toBe(true)
    expect(eta.polyline).toBeNull()
    expect(eta.seconds).toBeGreaterThan(120)
    expect(eta.seconds).toBeLessThan(180) // ~1 km at 25 km/h
  })

  it('does not swallow an abort as an approximate answer', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(computeEta(A, B, vi.fn(async () => { throw new Error('aborted') }), controller.signal)).rejects.toThrow()
  })
})

describe('formatEta', () => {
  it('rounds to whole minutes', () => {
    expect([10, 59, 60, 89, 90, 600].map(formatEta)).toEqual(['less than a minute', 'less than a minute', '1 min', '1 min', '2 min', '10 min'])
  })
})
