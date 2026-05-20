import type { RecurringRide } from '../types'

const PREFIX = '#ride='

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeShareUrl(
  ride: RecurringRide,
  baseUrl: string = window.location.origin + window.location.pathname,
): string {
  return `${baseUrl}${PREFIX}${toBase64Url(JSON.stringify(ride))}`
}

export function decodeShareHash(hash: string): RecurringRide | null {
  if (!hash.startsWith(PREFIX)) return null
  try {
    const parsed = JSON.parse(fromBase64Url(hash.slice(PREFIX.length))) as RecurringRide
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
