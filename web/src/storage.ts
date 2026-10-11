import type { RecurringRide } from './types'
import { pushRides } from './lib/rideSync'
import { EVENTS, STORAGE_KEYS } from './lib/constants'

export const RIDES_KEY = STORAGE_KEYS.rides
const OWNER_KEY = STORAGE_KEYS.ridesOwner
const LEGACY_RIDES_KEYS = ['loopride.rides.v1']

/**
 * One-time migration from Loopride v1 to the current ride record. The
 * physical key remains stable through the RideShare rebrand so no rider
 * history or active driver link is stranded.
 */
function migrateLegacy(): void {
  if (typeof localStorage === 'undefined') return
  const legacy = LEGACY_RIDES_KEYS.map((key) => [key, localStorage.getItem(key)] as const).find(
    ([, value]) => Boolean(value),
  )
  if (!legacy) return
  if (!localStorage.getItem(RIDES_KEY) && legacy[1]) {
    localStorage.setItem(RIDES_KEY, legacy[1])
  }
  LEGACY_RIDES_KEYS.forEach((key) => localStorage.removeItem(key))
}

function emitChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(EVENTS.ridesChanged))
  }
}

export function listRides(): RecurringRide[] {
  try {
    migrateLegacy()
    const raw = localStorage.getItem(RIDES_KEY)
    return raw ? (JSON.parse(raw) as RecurringRide[]) : []
  } catch {
    return []
  }
}

export function saveRide(ride: RecurringRide): void {
  const rides = listRides()
  const idx = rides.findIndex((r) => r.id === ride.id)
  if (idx >= 0) rides[idx] = ride
  else rides.unshift(ride)
  localStorage.setItem(RIDES_KEY, JSON.stringify(rides))
  emitChanged()
  pushRides(rides)
}

export function deleteRide(id: string): void {
  const rides = listRides().filter((r) => r.id !== id)
  localStorage.setItem(RIDES_KEY, JSON.stringify(rides))
  emitChanged()
  pushRides(rides)
}

export function getRide(id: string): RecurringRide | undefined {
  return listRides().find((r) => r.id === id)
}

/**
 * Tracks which signed-in user the local ride list belongs to. Empty string =
 * anonymous (no account). Used by rideSync to avoid leaking rides from one
 * account into another when accounts switch.
 */
export function getLocalRidesOwner(): string {
  return localStorage.getItem(OWNER_KEY) ?? ''
}

export function setLocalRidesOwner(owner: string): void {
  if (owner) localStorage.setItem(OWNER_KEY, owner)
  else localStorage.removeItem(OWNER_KEY)
}

/** Wipe local ride state + ownership tag. Called on sign-out. */
export function clearLocalRides(): void {
  localStorage.removeItem(RIDES_KEY)
  localStorage.removeItem(OWNER_KEY)
  emitChanged()
}
