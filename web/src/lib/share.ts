import type { RecurringRide } from '../types'

const PREFIX = '#ride='

function toBase64Url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return decodeURIComponent(escape(atob(padded)))
}

export function encodeShareUrl(ride: RecurringRide, baseUrl: string = window.location.origin + window.location.pathname): string {
  const payload = JSON.stringify(ride)
  return `${baseUrl}${PREFIX}${toBase64Url(payload)}`
}

export function decodeShareHash(hash: string): RecurringRide | null {
  if (!hash.startsWith(PREFIX)) return null
  try {
    const raw = fromBase64Url(hash.slice(PREFIX.length))
    const parsed = JSON.parse(raw) as RecurringRide
    if (
      typeof parsed?.id === 'string' &&
      typeof parsed.pickup === 'string' &&
      typeof parsed.dropoff === 'string' &&
      Array.isArray(parsed.days) &&
      typeof parsed.time === 'string' &&
      typeof parsed.driverName === 'string'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Drop the ride hash from the URL without disturbing other state. */
export function clearShareHash(): void {
  if (window.location.hash.startsWith(PREFIX)) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
}
