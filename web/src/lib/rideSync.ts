import { useEffect, useRef } from 'react'
import { app } from './app'
import {
  clearLocalRides,
  getLocalRidesOwner,
  listRides,
  setLocalRidesOwner,
} from '../storage'
import { EVENTS, KV_KEYS } from './constants'
import type { RecurringRide } from '../types'

/**
 * One-shot reconciliation between localStorage and FAS KV.
 *
 * Cross-account safety: localStorage carries a "owner" tag (user id). On
 * sign-in we honor remote-wins as before, but when remote is empty we only
 * push local if the local owner matches the signed-in user OR local is
 * anonymous (empty owner). If the local owner doesn't match, we clear local
 * before sync — that's the previous user's data, not ours.
 *
 * Anonymous users skip this entirely.
 */
export async function syncRides(): Promise<void> {
  const user = app?.auth?.user
  if (!user?.id || !app?.auth?.token) return

  const localOwner = getLocalRidesOwner()
  if (localOwner && localOwner !== user.id) {
    // Different user signed in; drop the stale local before reconciling.
    clearLocalRides()
  }

  try {
    const remote = await app.kv.get<RecurringRide[]>(KV_KEYS.rides)
    if (Array.isArray(remote) && remote.length > 0) {
      localStorage.setItem('loopride.rides.v2', JSON.stringify(remote))
      setLocalRidesOwner(user.id)
      window.dispatchEvent(new Event(EVENTS.ridesChanged))
      return
    }
    const local = listRides()
    if (local.length > 0) {
      await app.kv.set(KV_KEYS.rides, local)
    }
    setLocalRidesOwner(user.id)
  } catch {
    // Network/KV hiccup. Local stays authoritative; next sync will retry.
  }
}

/**
 * Fire-and-forget push of the current ride list to KV. Called from
 * storage.saveRide/deleteRide so every mutation propagates to other devices
 * without making the storage API async.
 */
export function pushRides(rides: RecurringRide[]): void {
  try {
    if (!app?.auth?.token || !app.kv) return
    void app.kv.set(KV_KEYS.rides, rides).catch(() => undefined)
  } catch {
    // SDK not fully wired (test stubs, partial mocks) — local stays the
    // source of truth.
  }
}

/**
 * Trigger syncRides() whenever the signed-in user changes. On sign-out,
 * clears local so the next sign-in starts clean.
 */
export function useRideSync(): void {
  const lastUserId = useRef<string | null>(null)

  useEffect(() => {
    const handle = (user: { id?: string } | null) => {
      const id = user?.id ?? null
      const previous = lastUserId.current
      lastUserId.current = id

      if (!id && previous) {
        // Just signed out — drop anything from the previous session.
        clearLocalRides()
        window.dispatchEvent(new Event(EVENTS.ridesChanged))
        return
      }
      if (id) void syncRides()
    }

    return app.auth.onChange(handle)
  }, [])
}
