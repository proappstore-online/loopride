import type { RecurringRide } from './types'
import { pushRides } from './lib/rideSync'
import { EVENTS, STORAGE_KEYS } from './lib/constants'

const RIDES_KEY = STORAGE_KEYS.rides
const OWNER_KEY = STORAGE_KEYS.ridesOwner
const LEGACY_RIDES_KEY_V1 = 'loopride.rides.v1'

/**
 * One-time migration: pre-rename data lived at loopride.rides.v1. Move it
 * over if we find it and the new key is empty. Safe to leave running — it's
 * a no-op after the first import.
 */
function migrateLegacy(): void {
  if (typeof localStorage === 'undefined') return
  const legacy = localStorage.getItem(LEGACY_RIDES_KEY_V1)
  if (!legacy) return
  if (!localStorage.getItem(RIDES_KEY)) {
    localStorage.setItem(RIDES_KEY, legacy)
  }
  localStorage.removeItem(LEGACY_RIDES_KEY_V1)
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
