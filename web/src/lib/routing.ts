import type { LatLng } from '../types'
import { app } from './app'
import { timed } from './telemetry'

export interface Route {
  /** GeoJSON LineString coordinates in [lng, lat] order. */
  coordinates: [number, number][]
  distanceMeters: number
  durationSeconds: number
}

/**
 * Fetch a driving route via the PAS Maps API (OSRM proxy), through the SDK so the request
 * carries the platform session. Throws on network error or 4xx/5xx; callers fall back to a
 * straight line (map) or a straight-line estimate (ETA). Accepts an AbortSignal so unmounting
 * or changing pickup mid-fetch cancels the request. Failures are counted and reported (domain
 * `maps`).
 */
export async function fetchRoute(
  from: LatLng,
  to: LatLng,
  opts?: { signal?: AbortSignal },
): Promise<Route> {
  return timed('maps', 'route_failed', async () => {
    const route = await app.maps.route(from, to, opts?.signal ? { signal: opts.signal } : undefined)
    return {
      coordinates: route.geometry.coordinates,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
    }
  })
}
