import type { LatLng } from '../types'

const PAS_API = 'https://api.proappstore.online'

export interface Route {
  /** GeoJSON LineString coordinates in [lng, lat] order. */
  coordinates: [number, number][]
  distanceMeters: number
  durationSeconds: number
}

/**
 * Fetch a driving route via the PAS Maps API (OSRM proxy). Throws on
 * network error or 4xx/5xx; callers should fall back to a straight line.
 *
 * Accepts an AbortSignal so unmounting / changing pickup mid-fetch cancels
 * the in-flight request.
 *
 * Calls the platform endpoint directly until the published SDK ships
 * `app.maps.route()` (added to pas/platform but not yet on npm).
 */
export async function fetchRoute(
  from: LatLng,
  to: LatLng,
  opts?: { signal?: AbortSignal },
): Promise<Route> {
  const url = new URL(`${PAS_API}/v1/maps/route`)
  url.searchParams.set('from', `${from.lat},${from.lng}`)
  url.searchParams.set('to', `${to.lat},${to.lng}`)
  const response = await fetch(url.toString(), opts?.signal ? { signal: opts.signal } : undefined)
  if (!response.ok) throw new Error(`route failed: ${response.status}`)
  const data = (await response.json()) as {
    geometry: { coordinates: [number, number][] }
    distanceMeters: number
    durationSeconds: number
  }
  return {
    coordinates: data.geometry.coordinates,
    distanceMeters: data.distanceMeters,
    durationSeconds: data.durationSeconds,
  }
}
