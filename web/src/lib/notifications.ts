import { app } from './app'

/**
 * Notifications. The server (mcp.json) decides who is told what, in the same
 * transaction as the trip event, so a notification exists exactly once and always
 * links to the right trip. This file renders them in the reader's language, reads
 * the inbox and preferences, and delivers push (and, with consent, email) on behalf
 * of the person whose action caused them. Delivery results are reported back so
 * failures are retried and visible. See docs/domain-model.md › Notifications.
 */
export type Locale = 'en' | 'es'
export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
]

export type Kind =
  | 'offer_received'
  | 'driver_assigned'
  | 'driver_en_route'
  | 'driver_arrived'
  | 'trip_started'
  | 'receipt_ready'
  | 'trip_cancelled'
  | 'rider_no_show'
  | 'driver_no_show'
  | 'dispute_resolved'

/** Kinds that may fall back to email (with consent) when push cannot be delivered. Mirrors the server. */
export const CRITICAL_KINDS: readonly Kind[] = ['driver_assigned', 'driver_arrived', 'receipt_ready', 'trip_cancelled', 'rider_no_show', 'driver_no_show']

export interface Notification {
  id: string
  kind: Kind
  role: 'rider' | 'driver'
  tripId: string | null
  requestId: string | null
  link: string
  params: Record<string, unknown>
  critical: boolean
  createdAt: number
  readAt: number | null
}

export interface Prefs {
  locale: Locale
  push: boolean
  emailFallback: boolean
  emailConsentAt: number | null
}

export const DEFAULT_PREFS: Prefs = { locale: 'en', push: true, emailFallback: false, emailConsentAt: null }

// ---- text ----
type Params = Record<string, unknown>
type Text = { title: string; body: string }
const usd = (cents: unknown) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '')
const str = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback)

const REASONS: Record<Locale, Record<string, string>> = {
  en: { changed_plans: 'plans changed', wait_too_long: 'the wait was too long', wrong_pickup: 'wrong pickup location', found_other: 'found another ride', rider_unreachable: 'the rider could not be reached', vehicle_issue: 'a vehicle problem', safety: 'a safety concern', too_far: 'the pickup was too far', other: 'another reason', ops_cancelled: 'support stepped in' },
  es: { changed_plans: 'cambió de planes', wait_too_long: 'la espera era demasiado larga', wrong_pickup: 'punto de recogida incorrecto', found_other: 'encontró otro viaje', rider_unreachable: 'no se pudo contactar al pasajero', vehicle_issue: 'un problema con el vehículo', safety: 'un problema de seguridad', too_far: 'la recogida estaba muy lejos', other: 'otro motivo', ops_cancelled: 'intervino soporte' },
}

const EN: Record<Kind, (p: Params) => Text> = {
  offer_received: (p) => ({ title: 'New ride request', body: `${str(p.pickup, 'Pickup')} → ${str(p.dropoff, 'drop-off')}. Respond within 30 seconds.` }),
  driver_assigned: (p) => ({ title: 'Your driver is confirmed', body: `${str(p.driver, 'Your driver')}${p.plate ? ` · ${str(p.plate)}` : ''} accepted your ride.` }),
  driver_en_route: () => ({ title: 'Your driver is on the way', body: 'Follow them live in the app.' }),
  driver_arrived: () => ({ title: 'Your driver has arrived', body: 'They are waiting at the pickup point.' }),
  trip_started: () => ({ title: 'Your trip has started', body: 'Enjoy the ride.' }),
  receipt_ready: (p) => ({ title: 'Your receipt is ready', body: p.total_cents != null ? `Trip total ${usd(p.total_cents)}.` : 'Your trip has ended.' }),
  trip_cancelled: (p) => ({
    title: 'Trip cancelled',
    body: `${p.by === 'rider' ? 'The rider cancelled' : p.by === 'driver' ? 'The driver cancelled' : 'Support cancelled this trip'}${p.by !== 'ops' && p.reason ? `: ${REASONS.en[str(p.reason, 'other')] ?? REASONS.en.other}` : ''}.${typeof p.fee_cents === 'number' && p.fee_cents > 0 ? ` Cancellation fee ${usd(p.fee_cents)}.` : ''}`,
  }),
  rider_no_show: (p) => ({ title: 'Trip cancelled: pickup no-show', body: `Your driver waited at the pickup and could not meet you.${typeof p.fee_cents === 'number' && p.fee_cents > 0 ? ` No-show fee ${usd(p.fee_cents)}.` : ''}` }),
  driver_no_show: () => ({ title: 'Trip cancelled: you did not arrive', body: 'The rider reported that you did not reach the pickup.' }),
  dispute_resolved: (p) => ({ title: 'Your report was reviewed', body: p.decision === 'upheld' ? 'Support upheld your report.' : 'Support reviewed your report and kept the original outcome.' }),
}

const ES: Record<Kind, (p: Params) => Text> = {
  offer_received: (p) => ({ title: 'Nueva solicitud de viaje', body: `${str(p.pickup, 'Recogida')} → ${str(p.dropoff, 'destino')}. Responde en 30 segundos.` }),
  driver_assigned: (p) => ({ title: 'Tu conductor está confirmado', body: `${str(p.driver, 'Tu conductor')}${p.plate ? ` · ${str(p.plate)}` : ''} aceptó tu viaje.` }),
  driver_en_route: () => ({ title: 'Tu conductor va en camino', body: 'Síguelo en vivo en la app.' }),
  driver_arrived: () => ({ title: 'Tu conductor llegó', body: 'Te espera en el punto de recogida.' }),
  trip_started: () => ({ title: 'Tu viaje comenzó', body: 'Buen viaje.' }),
  receipt_ready: (p) => ({ title: 'Tu recibo está listo', body: p.total_cents != null ? `Total del viaje ${usd(p.total_cents)}.` : 'Tu viaje terminó.' }),
  trip_cancelled: (p) => ({
    title: 'Viaje cancelado',
    body: `${p.by === 'rider' ? 'El pasajero canceló' : p.by === 'driver' ? 'El conductor canceló' : 'Soporte canceló este viaje'}${p.by !== 'ops' && p.reason ? `: ${REASONS.es[str(p.reason, 'other')] ?? REASONS.es.other}` : ''}.${typeof p.fee_cents === 'number' && p.fee_cents > 0 ? ` Cargo por cancelación ${usd(p.fee_cents)}.` : ''}`,
  }),
  rider_no_show: (p) => ({ title: 'Viaje cancelado: no se presentó', body: `Tu conductor esperó en la recogida y no pudo encontrarte.${typeof p.fee_cents === 'number' && p.fee_cents > 0 ? ` Cargo por ausencia ${usd(p.fee_cents)}.` : ''}` }),
  driver_no_show: () => ({ title: 'Viaje cancelado: no llegaste', body: 'El pasajero informó que no llegaste al punto de recogida.' }),
  dispute_resolved: (p) => ({ title: 'Revisamos tu reporte', body: p.decision === 'upheld' ? 'Soporte aceptó tu reporte.' : 'Soporte revisó tu reporte y mantuvo el resultado original.' }),
}

const CATALOGUE: Record<Locale, Record<Kind, (p: Params) => Text>> = { en: EN, es: ES }

/** Text for a notification in a language; unknown languages fall back to English. */
export function renderNotification(n: { kind: Kind; params: Params }, locale: string = 'en'): Text {
  const table = CATALOGUE[(locale as Locale) in CATALOGUE ? (locale as Locale) : 'en']
  return table[n.kind](n.params)
}

export const EMAIL_CONSENT_TEXT =
  'Email me about important trip events (driver confirmed, arrived, cancelled, receipts) only when a push notification could not be delivered. Sent to the address on your account; every email has a one-click unsubscribe. You can turn this off at any time.'
export const SMS_NOTE = 'Text messages are not available.'

// ---- server calls ----
const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

interface InboxRow {
  id: string
  kind: Kind
  role: 'rider' | 'driver'
  trip_id: string | null
  request_id: string | null
  link: string
  params: string
  critical: number
  created_at: number
  read_at: number | null
}

function parseParams(raw: string): Params {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Params) : {}
  } catch {
    return {}
  }
}

export async function loadInbox(limit = 50): Promise<Notification[]> {
  const rows = await call<InboxRow[]>('list_my_notifications', { limit })
  return rows.map((r) => ({ id: r.id, kind: r.kind, role: r.role, tripId: r.trip_id, requestId: r.request_id, link: r.link, params: parseParams(r.params), critical: r.critical === 1, createdAt: r.created_at, readAt: r.read_at }))
}

export const markRead = (id?: string) => call('mark_notifications_read', { id: id ?? null })

export async function loadPrefs(): Promise<Prefs> {
  const [row] = await call<{ locale: Locale; push: number; email_fallback: number; email_consent_at: number | null }[]>('get_notification_prefs')
  return row ? { locale: row.locale, push: row.push === 1, emailFallback: row.email_fallback === 1, emailConsentAt: row.email_consent_at } : DEFAULT_PREFS
}

export const savePrefs = (p: Pick<Prefs, 'locale' | 'push' | 'emailFallback'>) =>
  call('set_notification_prefs', { locale: p.locale, push: p.push ? 1 : 0, email_fallback: p.emailFallback ? 1 : 0 })

/** Ask the browser for permission and register for push. Returns false if the user declines. */
export async function enablePush(): Promise<boolean> {
  try {
    await app.notifications.subscribe()
    return await app.notifications.isSubscribed()
  } catch {
    return false
  }
}

// ---- delivery on behalf of the person whose action caused the notification ----
interface DeliveryRow {
  recipient: string
  id: string
  kind: Kind
  link: string
  params: string
  channel: 'push' | 'email'
  locale: string
}

export const MAX_PER_PUMP = 5

export interface PumpResult {
  sent: number
  failed: number
  skipped: number
}

let pumping = false

/** Send what this user owes (at most a few at a time, in the recipient's language) and report every result. */
export async function deliverPending(origin: string = typeof window === 'undefined' ? '' : window.location.origin): Promise<PumpResult> {
  const result: PumpResult = { sent: 0, failed: 0, skipped: 0 }
  if (pumping) return result
  pumping = true
  try {
    const rows = (await call<DeliveryRow[]>('list_pending_deliveries')).slice(0, MAX_PER_PUMP)
    for (const row of rows) {
      const text = renderNotification({ kind: row.kind, params: parseParams(row.params) }, row.locale)
      // The platform only accepts links on the app's own origin; the tag lets the device collapse a duplicate.
      const payload = { title: text.title, body: text.body, url: `${origin}${row.link}`, tag: row.id }
      let outcome: 'sent' | 'failed' | 'skipped' = 'failed'
      let error = ''
      try {
        const r = await app.notifications.notifyUser(row.recipient, payload, { channel: row.channel })
        if (row.channel === 'push') {
          outcome = r.sent > 0 ? 'sent' : 'failed'
          if (outcome === 'failed') error = 'no push delivered'
        } else if (r.email === 'sent') outcome = 'sent'
        else if (r.email === 'skipped') {
          outcome = 'skipped'
          error = r.skipped ?? 'skipped'
        } else error = 'email failed'
      } catch (e) {
        error = e instanceof Error ? e.message : 'error'
      }
      try {
        await call(row.channel === 'push' ? 'report_push_result' : 'report_email_result', { recipient: row.recipient, notification_id: row.id, outcome, error: error || null })
      } catch {
        /* the next pump will see it still pending and try again */
      }
      result[outcome === 'sent' ? 'sent' : outcome === 'skipped' ? 'skipped' : 'failed'] += 1
    }
    return result
  } finally {
    pumping = false
  }
}
