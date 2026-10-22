import { app } from './app'
import { isFinished, type TripState } from './tripLifecycle'

/**
 * Rider and driver safety client (issue #12). The server owns who may report, what is urgent, the
 * rate limit, the snapshot of trip context and the escalation to staff (submit_safety_report); this
 * file names the categories, holds the on-screen wording and wraps the calls. Policy in docs/safety.md.
 */
export interface SafetyCategory { code: string; label: string; urgent: boolean }

/** `urgent` mirrors the server (which decides it): urgent reports alert staff, but see SAFETY_COPY.emergency. */
export const SAFETY_CATEGORIES: readonly SafetyCategory[] = [
  { code: 'emergency', label: 'I need urgent help', urgent: true },
  { code: 'assault', label: 'Violence or a physical threat', urgent: true },
  { code: 'impaired', label: 'The other person seems impaired', urgent: true },
  { code: 'unsafe_driving', label: 'Unsafe driving', urgent: false },
  { code: 'harassment', label: 'Harassment or unwelcome behaviour', urgent: false },
  { code: 'discrimination', label: 'Discrimination', urgent: false },
  { code: 'vehicle_mismatch', label: "The driver or vehicle doesn't match the app", urgent: false },
  { code: 'other', label: 'Something else', urgent: false },
]

/**
 * Wording shown to riders and drivers. It is deliberately jurisdiction-neutral: it names no emergency
 * number and promises no response time. docs/safety.md lists it as needs-human until someone with local
 * knowledge has reviewed it for each place the service operates.
 */
export const SAFETY_COPY = {
  emergency: 'If you are in immediate danger, contact your local emergency services now. Do not wait for a reply from us.',
  limits: 'LoopRide is not an emergency service. We cannot call emergency services for you, send help to your location or tell you how quickly staff will see a report.',
  sent: 'Your report was sent to our team with the details of this trip.',
  sentUrgent: 'Your report was sent to our team and marked urgent. This is not a substitute for emergency services; if you are in danger, contact them directly.',
  after: 'Reports are reviewed by staff. We may suspend a driver or block a rider while we look into it, and we may contact you.',
  blocked: "Your account can't request rides right now. Contact support if you think this is a mistake.",
} as const

export const isUrgent = (code: string) => SAFETY_CATEGORIES.some((c) => c.code === code && c.urgent)

/** A trip can be reported while it is under way, and for 7 days after it ends (the server enforces both). */
export const REPORT_WINDOW_MS = 7 * 86_400_000

export const canReportSafety = (t: Pick<TripState, 'phase' | 'endedAt'>, now = Date.now()) =>
  !isFinished(t.phase) || (t.endedAt != null && now - t.endedAt < REPORT_WINDOW_MS)

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

/** A key the server uses to ignore a repeated submission, so a retry after a timeout cannot file twice. */
export const newReportKey = () => crypto.randomUUID()

export interface SafetyReportInput { riderId: string; tripId: string; category: string; note?: string; key: string }

export const submitSafetyReport = (r: SafetyReportInput) =>
  call('submit_safety_report', { rider_id: r.riderId, trip_id: r.tripId, request_key: r.key, category: r.category, note: r.note?.trim() || null })

export interface MySafetyReport { id: string; trip_id: string; category: string; urgency: 'urgent' | 'standard'; status: 'open' | 'in_review' | 'resolved'; created_at: number }
export const listMySafetyReports = () => call<MySafetyReport[]>('list_my_safety_reports', { limit: 50 })

/** Whether a report with this key reached the server. The call may fail after the server accepted it. */
export async function reportExists(key: string): Promise<boolean> {
  const mine = await listMySafetyReports()
  return mine.some((r) => r.id.endsWith(`:${key}`))
}

/** Whether operations have blocked the signed-in person from requesting rides. Unknown counts as not blocked. */
export async function accountBlocked(): Promise<boolean> {
  try {
    const [row] = (await call<{ rider_blocked: number }[]>('get_my_account_standing')) ?? []
    return row?.rider_blocked === 1
  } catch {
    return false
  }
}
