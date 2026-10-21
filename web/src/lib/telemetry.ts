/**
 * Structured errors and metrics. Two sinks, both fed from here:
 *  - the platform's app log (`app.logs.capture`), which the owner reads in the PAS console, and
 *  - the app's own database (`report_client_event` / `report_client_metrics`), which is what
 *    the operations console computes alerts from.
 *
 * Nothing personal is ever recorded: no names, addresses, coordinates, contact details or
 * person ids, only opaque trip/ride ids, action names, status codes and timings. Free text is
 * redacted and clipped. Every function is silent on failure: telemetry must never break the
 * thing it observes. See docs/runbooks/README.md.
 */
export type Domain = 'request' | 'dispatch' | 'tracking' | 'notification' | 'payment' | 'maps' | 'transition'
export const DOMAINS: readonly Domain[] = ['request', 'dispatch', 'tracking', 'notification', 'payment', 'maps', 'transition']

export type Severity = 'warn' | 'error'

interface Sink {
  logs?: { capture(level: 'info' | 'warn' | 'error', category: string, message: string, data?: unknown): void }
  actions: { call: (name: string, params?: Record<string, unknown>) => Promise<unknown> }
}

const DISPATCH = ['request_dispatch', 'dispatch_tick', 'get_dispatch_status', 'accept_offer', 'decline_offer', 'list_my_offers', 'set_driver_availability', 'get_my_driver_availability', 'update_driver_location', 'get_my_driver_location']
const TRACKING = ['publish_driver_location', 'get_driver_location']
const NOTIFICATION = ['list_my_notifications', 'mark_notifications_read', 'list_pending_deliveries', 'report_push_result', 'report_email_result', 'get_notification_prefs', 'set_notification_prefs']
const PAYMENT = ['get_receipt', 'list_my_receipts', 'list_receipt_adjustments', 'list_my_earnings']
const TRANSITION = ['advance_trip', 'start_trip', 'driver_cancel_trip', 'report_rider_no_show', 'report_driver_no_show', 'cancel_ride', 'open_dispute', 'get_my_trip_lifecycle', 'get_driver_trip', 'preview_cancellation']

/** Which part of the service an action belongs to. Everything else (quotes, rides, profile, account) is a request. */
export function domainOf(action: string): Domain {
  if (DISPATCH.includes(action)) return 'dispatch'
  if (TRACKING.includes(action)) return 'tracking'
  if (NOTIFICATION.includes(action)) return 'notification'
  if (PAYMENT.includes(action)) return 'payment'
  if (TRANSITION.includes(action)) return 'transition'
  return 'request'
}

/** Calls to the telemetry endpoints themselves are never instrumented (that would loop). */
const isTelemetry = (action: string) => action.startsWith('report_client_')

export const SLOW_MS = 2000
const DETAIL_MAX = 200

/** Strip anything that could identify a person from free text, then clip it. */
export function redact(text: unknown): string {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, '[coords]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX)
}

// ---- metrics ----
interface Counter { calls: number; errors: number; slow: number; latency: number }
const fresh = (): Counter => ({ calls: 0, errors: 0, slow: 0, latency: 0 })
let counters = new Map<Domain, Counter>()

export function recordCall(domain: Domain, ok: boolean, latencyMs: number): void {
  const c = counters.get(domain) ?? fresh()
  c.calls += 1
  if (!ok) c.errors += 1
  if (latencyMs > SLOW_MS) c.slow += 1
  c.latency += Math.max(0, Math.round(latencyMs))
  counters.set(domain, c)
}

/** Take and clear the counters as the JSON the server expects. Null when there is nothing to send. */
export function takeMetrics(): string | null {
  if (counters.size === 0) return null
  const payload = [...counters.entries()].map(([d, c]) => ({ d, c: c.calls, e: c.errors, s: c.slow, l: c.latency }))
  counters = new Map()
  return JSON.stringify(payload)
}

// ---- events ----
export interface ErrorReport {
  domain: Domain
  /** Short snake_case name of what went wrong, e.g. `action_failed`, `step_rejected`. */
  code: string
  severity?: Severity
  action?: string
  status?: number
  latencyMs?: number
  tripId?: string
  requestId?: string
  error?: unknown
  detail?: string
}

let sink: Sink | null = null
const recent = new Map<string, number>()
let sentThisMinute: number[] = []

export const DEDUPE_MS = 30_000
export const MAX_EVENTS_PER_MINUTE = 10

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === 'number' && s >= 0 && s <= 999 ? s : undefined
}

/**
 * Record a structured error: to the platform log immediately, and to the database for alerting.
 * The same failure repeating is sent once per 30 seconds, and no more than 10 events a minute go out.
 */
export function reportError(report: ErrorReport, now: number = Date.now()): void {
  try {
    const status = report.status ?? statusOf(report.error)
    // Client errors (4xx) are expected from time to time (expired session, lost race); server and network failures are not.
    const severity: Severity = report.severity ?? (status !== undefined && status >= 400 && status < 500 ? 'warn' : 'error')
    const detail = redact(report.detail ?? (report.error instanceof Error ? report.error.message : report.error))
    const data = { domain: report.domain, code: report.code, action: report.action, status, latencyMs: report.latencyMs, tripId: report.tripId, requestId: report.requestId, detail }

    sink?.logs?.capture(severity === 'error' ? 'error' : 'warn', `loopride.${report.domain}`, report.code, data)

    const key = `${report.domain}|${report.code}|${report.action ?? ''}|${status ?? ''}`
    const last = recent.get(key)
    if (last !== undefined && now - last < DEDUPE_MS) return
    sentThisMinute = sentThisMinute.filter((t) => now - t < 60_000)
    if (sentThisMinute.length >= MAX_EVENTS_PER_MINUTE) return
    recent.set(key, now)
    sentThisMinute.push(now)
    if (recent.size > 200) recent.clear()

    void sink?.actions
      .call('report_client_event', {
        domain: report.domain,
        code: report.code,
        severity,
        action: report.action ?? null,
        status: status ?? null,
        latency_ms: report.latencyMs !== undefined ? Math.max(0, Math.min(3_600_000, Math.round(report.latencyMs))) : null,
        trip_id: report.tripId ?? null,
        request_id: report.requestId ?? null,
        detail: detail || null,
      })
      .catch(() => undefined)
  } catch {
    /* never throw from telemetry */
  }
}

/** Time an external call that is not a platform action (maps, geolocation) and report its failures. */
export async function timed<T>(domain: Domain, code: string, run: () => Promise<T>, extra: Partial<ErrorReport> = {}): Promise<T> {
  const start = Date.now()
  try {
    const result = await run()
    recordCall(domain, true, Date.now() - start)
    return result
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error // a cancelled request is not a failure
    recordCall(domain, false, Date.now() - start)
    reportError({ domain, code, error, latencyMs: Date.now() - start, severity: 'warn', ...extra })
    throw error
  }
}

// ---- platform action wrapper ----
const idsFrom = (params: Record<string, unknown> | undefined) => {
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 80 ? v : undefined)
  return { tripId: str(params?.trip_id), requestId: str(params?.request_id) ?? str(params?.ride_id) }
}

/** Wrap an Actions-like object's `call` so every platform action is counted, timed and its failures reported. */
export function instrumentActions(actions: { call: (name: string, params?: Record<string, unknown>) => Promise<unknown> }): void {
  const original = actions.call.bind(actions)
  actions.call = async (name: string, params?: Record<string, unknown>) => {
    if (isTelemetry(name)) return original(name, params)
    const domain = domainOf(name)
    const start = Date.now()
    try {
      const result = await original(name, params)
      recordCall(domain, true, Date.now() - start)
      return result
    } catch (error) {
      const latencyMs = Date.now() - start
      recordCall(domain, false, latencyMs)
      reportError({ domain, code: 'action_failed', action: name, latencyMs, error, ...idsFrom(params) })
      throw error
    }
  }
}

// ---- lifecycle ----
export const FLUSH_MS = 60_000
let timer: ReturnType<typeof setInterval> | null = null

export async function flushMetrics(): Promise<void> {
  try {
    const payload = takeMetrics()
    if (payload && sink) await sink.actions.call('report_client_metrics', { payload })
  } catch {
    /* counters for that minute are lost; that is acceptable */
  }
}

/** Connect telemetry to the app: wrap its actions, flush counters every minute and when the page hides. */
export function installTelemetry(app: Sink): void {
  sink = app
  instrumentActions(app.actions)
  if (typeof window === 'undefined') return
  if (timer) clearInterval(timer)
  timer = setInterval(() => void flushMetrics(), FLUSH_MS)
  window.addEventListener('pagehide', () => void flushMetrics())
}

/** For tests: forget everything. */
export function resetTelemetry(): void {
  sink = null
  counters = new Map()
  recent.clear()
  sentThisMinute = []
  if (timer) clearInterval(timer)
  timer = null
}
