import type { LatLng } from '../types'

/**
 * Linear interpolation between two LatLng points. Geodesic, not great-circle —
 * accurate enough for short urban routes shown on a city-scale map.
 *
 * @param t fraction in [0,1]; values outside the range are clamped.
 */
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  const c = Math.max(0, Math.min(1, t))
  return { lat: a.lat + (b.lat - a.lat) * c, lng: a.lng + (b.lng - a.lng) * c }
}
