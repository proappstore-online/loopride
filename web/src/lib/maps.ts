import type { LatLng } from '../types'

const PAS_API = 'https://api.proappstore.online'

export interface GeocodeMatch {
  lat: number
  lng: number
  displayName: string
}

/**
 * Geocode a text query through the PAS Maps API. Accepts an AbortSignal so
 * a stale request (older debounced keystroke) gets cancelled cleanly when a
 * newer one fires — avoids burning Nominatim quota and lets the latest
 * result always win.
 *
 * Direct fetch wrapper because @proappstore/sdk@1.5.x on npm doesn't yet
 * expose the signal option. Switch to app.maps.geocode(q, n, {signal}) once
 * the SDK is republished from pas/platform/.
 */
export async function geocode(
  query: string,
  limit = 5,
  opts?: { signal?: AbortSignal },
): Promise<GeocodeMatch[]> {
  const url = new URL(`${PAS_API}/v1/maps/geocode`)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  const response = await fetch(url.toString(), opts?.signal ? { signal: opts.signal } : undefined)
  if (!response.ok) throw new Error(`geocode failed: ${response.status}`)
  const data = (await response.json()) as {
    results: Array<{ lat: number; lng: number; displayName: string }>
  }
  return data.results.map((r) => ({ lat: r.lat, lng: r.lng, displayName: r.displayName }))
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
