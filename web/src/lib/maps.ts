import type { LatLng } from '../types'
import { app } from './app'
import { timed } from './telemetry'

export interface GeocodeMatch {
  lat: number
  lng: number
  displayName: string
}

/**
 * Geocode a text query through the PAS Maps API, using the SDK so the request carries the
 * platform session (the endpoint rejects anonymous calls with 401). Accepts an AbortSignal so a
 * stale request (older debounced keystroke) gets cancelled cleanly when a newer one fires.
 * Failures are counted and reported (domain `maps`); a cancelled request is not a failure.
 */
export async function geocode(
  query: string,
  limit = 5,
  opts?: { signal?: AbortSignal },
): Promise<GeocodeMatch[]> {
  return timed('maps', 'geocode_failed', async () => {
    const results = await app.maps.geocode(query, limit, opts?.signal ? { signal: opts.signal } : undefined)
    return results.map((r) => ({ lat: r.lat, lng: r.lng, displayName: r.displayName }))
  })
}

/** Single best match for an address. null if no result. */
export async function firstMatch(
  query: string,
  opts?: { signal?: AbortSignal },
): Promise<LatLng | null> {
  const matches = await geocode(query, 1, opts)
  if (!matches[0]) return null
  return { lat: matches[0].lat, lng: matches[0].lng }
}
