import { useEffect } from 'react'
import { app } from './app'
import { listRides } from '../storage'
import type { RecurringRide } from '../types'

const KV_KEY = 'rides.v1'
const LOCAL_KEY = 'loopride.rides.v1'

/**
 * One-shot reconciliation between localStorage and FAS KV.
 *
 * - Remote has data → adopt it locally (cross-device pickup).
 * - Remote empty, local has data → push local to remote (first sign-in).
 * - Both empty → no-op.
 * - Both have data → remote wins. Keeps the merge logic simple; conflict
 *   resolution is a fuller-product problem (last-write-wins by createdAt
 *   would need a per-ride timestamp on every mutation, not just creation).
 *
 * Anonymous users skip this entirely.
 */
export async function syncRides(): Promise<void> {
  if (!app.auth.token) return
  try {
    const remote = await app.kv.get<RecurringRide[]>(KV_KEY)
    if (Array.isArray(remote) && remote.length > 0) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(remote))
      window.dispatchEvent(new Event('loopride:rides-synced'))
      return
    }
    const local = listRides()
    if (local.length > 0) {
      await app.kv.set(KV_KEY, local)
    }
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
    void app.kv.set(KV_KEY, rides).catch(() => undefined)
  } catch {
    // SDK not fully wired (test stubs, partial mocks) — local stays the
    // source of truth.
  }
}

/** Trigger syncRides() whenever the signed-in user changes. */
export function useRideSync(): void {
  useEffect(() => {
    const run = () => void syncRides()
    run()
    return app.auth.onChange(run)
  }, [])
}
