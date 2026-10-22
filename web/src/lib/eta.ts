import type { LatLng } from '../types'
import { fetchRoute } from './routing'

/** Location freshness, from the age of the driver's last accepted update. */
export type Freshness = 'live' | 'delayed' | 'stale' | 'offline'

export const LIVE_MS = 15_000
export const DELAYED_MS = 60_000
export const STALE_MS = 5 * 60_000

export function freshness(ageMs: number): Freshness {
  if (ageMs <= LIVE_MS) return 'live'
  if (ageMs <= DELAYED_MS) return 'delayed'
  if (ageMs <= STALE_MS) return 'stale'
  return 'offline'
}

/** A position that old no longer says where the driver is, so no ETA is derived from it. */
export const etaTrusted = (f: Freshness) => f === 'live' || f === 'delayed'

const EARTH_M = 6_371_000
export function distanceM(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Only the leg the driver is on matters: to the pickup until the rider is on board, then to the drop-off. */
export function etaTarget(phase: string, pickup: LatLng | null, dropoff: LatLng | null): LatLng | null {
  if (phase === 'scheduled' || phase === 'en_route') return pickup
  if (phase === 'in_progress') return dropoff
  return null
}

export const RECOMPUTE_MOVED_M = 150
export const RECOMPUTE_EVERY_MS = 30_000

/** Re-ask the routing service when the driver has moved meaningfully or the last answer is old. */
export function shouldRecompute(last: { from: LatLng; target: LatLng; at: number } | null, from: LatLng, target: LatLng, now: number): boolean {
  if (!last) return true
  if (last.target.lat !== target.lat || last.target.lng !== target.lng) return true
  if (now - last.at >= RECOMPUTE_EVERY_MS) return true
  return distanceM(last.from, from) >= RECOMPUTE_MOVED_M
}

export interface Eta {
  seconds: number
  distanceM: number
  /** True when the routing service was unavailable and this is a straight-line estimate. */
  approximate: boolean
  /** Driver-to-target road geometry ([lng, lat]) when the routing service answered. */
  polyline: [number, number][] | null
}

const FALLBACK_SPEED_MPS = 7 // about 25 km/h through a city

/** ETA from the driver's current position along current route data; falls back to straight line. */
export async function computeEta(from: LatLng, to: LatLng, route: typeof fetchRoute = fetchRoute, signal?: AbortSignal): Promise<Eta> {
  try {
    const r = await route(from, to, signal ? { signal } : undefined)
    return { seconds: r.durationSeconds, distanceM: r.distanceMeters, approximate: false, polyline: r.coordinates }
  } catch {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const d = distanceM(from, to)
    return { seconds: d / FALLBACK_SPEED_MPS, distanceM: d, approximate: true, polyline: null }
  }
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return 'less than a minute'
  const m = Math.round(seconds / 60)
  return m === 1 ? '1 min' : `${m} min`
}

/** Where the driver is, in words, from the age of their last position. */
export function locationSummary(state: Freshness | null, ageSec: number | null): string {
  if (state === 'live') return `Live, updated ${ageSec ?? 0} seconds ago`
  if (state === 'delayed') return `Delayed, last updated ${ageSec ?? 0} seconds ago`
  if (state === 'stale') return `Last seen ${Math.max(1, Math.round((ageSec ?? 0) / 60))} minutes ago`
  if (state === 'offline') return 'Driver is offline'
  return 'No live location yet'
}
