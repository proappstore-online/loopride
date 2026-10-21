import { app } from './app'
import { STORAGE_KEYS } from './constants'

/**
 * Location consent and retention. Precise location is only collected from a driver who has agreed,
 * for one stated purpose each, and the server refuses the write without a recorded agreement
 * (mcp.json: `update_driver_location`, `set_driver_availability`, `publish_driver_location`).
 * Withdrawing deletes what was collected under that purpose at once. The notices describe what the
 * code does; they are not legal terms. See docs/privacy.md.
 */
export type LocationPurpose = 'dispatch_availability' | 'trip_tracking'

/** Bump when a notice changes in substance, so the stored agreement says which wording was shown. */
export const NOTICE_VERSION = '2026-10-a'

export interface PurposeNotice {
  purpose: LocationPurpose
  title: string
  notice: string
  /** What turning it off does. */
  withdrawEffect: string
}

export const PURPOSES: readonly PurposeNotice[] = [
  {
    purpose: 'dispatch_availability',
    title: 'Location while available for requests',
    notice:
      'While you are available, RideShare keeps your latest position and service area so nearby ride requests can be matched to you. ' +
      'It is used only for matching, replaced each time it updates, deleted when you go offline, and removed automatically after 24 hours.',
    withdrawEffect: 'Deletes your stored position, takes you offline and withdraws open offers.',
  },
  {
    purpose: 'trip_tracking',
    title: 'Location during a trip',
    notice:
      'While you drive a trip, your position is sent every few seconds, rounded to about 11 m, so the rider can watch you arrive. ' +
      'Only the latest position is kept, it is deleted when the trip ends and removed after 24 hours at the latest. ' +
      'A snapshot at arrival, start and end is kept for 30 days for dispute handling; staff see exact coordinates only after logging a reason.',
    withdrawEffect: 'Stops sharing and deletes your live trip positions. The rider will no longer see you approach.',
  },
]

export const noticeFor = (purpose: LocationPurpose): PurposeNotice => PURPOSES.find((p) => p.purpose === purpose)!

interface ConsentRow {
  purpose: LocationPurpose
  granted: number
  notice_version: string
  granted_at: number | null
  withdrawn_at: number | null
}

export interface Consent {
  granted: boolean
  noticeVersion: string
  grantedAt: number | null
  withdrawnAt: number | null
}

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

/** Each purpose maps to its record; a purpose never answered has no entry, which counts as not agreed. */
export async function loadConsents(): Promise<Partial<Record<LocationPurpose, Consent>>> {
  const rows = await call<ConsentRow[]>('get_my_location_consents')
  const out: Partial<Record<LocationPurpose, Consent>> = {}
  for (const r of rows) out[r.purpose] = { granted: r.granted === 1, noticeVersion: r.notice_version, grantedAt: r.granted_at, withdrawnAt: r.withdrawn_at }
  return out
}

/** A consent counts only when it is on and was given for the current wording. */
export const isCurrent = (c: Consent | undefined): boolean => c?.granted === true && c.noticeVersion === NOTICE_VERSION

export const setLocationConsent = (purpose: LocationPurpose, granted: boolean) =>
  call('set_location_consent', { purpose, granted: granted ? 1 : 0, notice_version: NOTICE_VERSION })

const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Ask the server to delete data past its retention period. Expiry also happens as a side effect of
 * other actions, so this is a backstop for quiet periods; it runs at most every 6 hours per device
 * and never surfaces an error.
 */
export async function runRetention(now = Date.now()): Promise<boolean> {
  try {
    const last = Number(localStorage.getItem(STORAGE_KEYS.retention) ?? 0)
    if (now - last < RETENTION_EVERY_MS) return false
    localStorage.setItem(STORAGE_KEYS.retention, String(now))
    await call('purge_expired_data')
    return true
  } catch {
    return false
  }
}
