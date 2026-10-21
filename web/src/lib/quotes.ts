import { app } from './app'
import type { LatLng, VehicleType } from '../types'
import { VEHICLES } from '../types'

/**
 * On-demand quote client. The server prices (mcp.json › create_quote), checks
 * driver eligibility, expires and invalidates quotes (accept_quote); this file
 * only sends the geocoded, routed trip and reads the result back.
 * See docs/domain-model.md › Quotes and the on-demand request flow.
 */
export interface QuoteRoute {
  pickup: { label: string; coord: LatLng }
  dropoff: { label: string; coord: LatLng }
  distanceMeters: number
  durationSeconds: number
}

export interface Quote {
  id: string
  vehicle: VehicleType
  distanceM: number
  durationS: number
  baseCents: number
  distanceCents: number
  timeCents: number
  bookingFeeCents: number
  minAdjustCents: number
  surgeMilli: number
  totalCents: number
  nearbyDrivers: number
  expiresAt: number
}

interface QuoteRow {
  id: string
  vehicle_class: VehicleType
  distance_m: number
  duration_s: number
  base_cents: number
  distance_cents: number
  time_cents: number
  booking_fee_cents: number
  min_adjust_cents: number
  surge_milli: number
  total_cents: number
  nearby_drivers: number
  expires_at: number
}

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

/** A tier can be requested only when at least one free, qualified driver is nearby. */
export const isEligible = (q: Pick<Quote, 'nearbyDrivers'>) => q.nearbyDrivers > 0
export const isExpired = (q: Pick<Quote, 'expiresAt'>, now = Date.now()) => q.expiresAt <= now
export const secondsLeft = (q: Pick<Quote, 'expiresAt'>, now = Date.now()) => Math.max(0, Math.ceil((q.expiresAt - now) / 1000))
export const surgeLabel = (surgeMilli: number) => (surgeMilli > 1000 ? `${Number((surgeMilli / 1000).toFixed(2))}×` : null)

/** Price all three tiers for one route. Returns the stored quotes, cheapest first. */
export async function requestQuotes(route: QuoteRoute): Promise<Quote[]> {
  const ids: { vehicle: VehicleType; quoteId: string }[] = VEHICLES.map((v) => ({ vehicle: v.id, quoteId: crypto.randomUUID() }))
  await Promise.all(
    ids.map(({ vehicle, quoteId }) =>
      call('create_quote', {
        quote_id: quoteId,
        vehicle_class: vehicle,
        pickup_label: route.pickup.label,
        pickup_lat: route.pickup.coord.lat,
        pickup_lng: route.pickup.coord.lng,
        dropoff_label: route.dropoff.label,
        dropoff_lat: route.dropoff.coord.lat,
        dropoff_lng: route.dropoff.coord.lng,
        distance_m: Math.round(route.distanceMeters),
        duration_s: Math.round(route.durationSeconds),
      }),
    ),
  )
  const rows = await call<QuoteRow[]>('list_pending_quotes')
  const mine = new Set(ids.map((i) => i.quoteId))
  return rows.filter((r) => mine.has(r.id)).map(fromRow)
}

const fromRow = (r: QuoteRow): Quote => ({
  id: r.id,
  vehicle: r.vehicle_class,
  distanceM: r.distance_m,
  durationS: r.duration_s,
  baseCents: r.base_cents,
  distanceCents: r.distance_cents,
  timeCents: r.time_cents,
  bookingFeeCents: r.booking_fee_cents,
  minAdjustCents: r.min_adjust_cents,
  surgeMilli: r.surge_milli,
  totalCents: r.total_cents,
  nearbyDrivers: r.nearby_drivers,
  expiresAt: r.expires_at,
})

export type AcceptResult = { ok: true; rideId: string } | { ok: false; reason: 'expired' | 'changed' | 'unavailable' }

export const REASON_TEXT: Record<Extract<AcceptResult, { ok: false }>['reason'], string> = {
  expired: 'That quote expired. Get new quotes to continue.',
  changed: 'Your route or local demand changed, so that price is no longer valid. Get new quotes to continue.',
  unavailable: "We couldn't confirm that quote. Get new quotes to continue.",
}

/**
 * Accept a quote for the route the rider is currently looking at. The server
 * creates the ride and its dispatch request atomically, or refuses; the
 * outcome is read back from the quote's status.
 */
export async function acceptQuote(quote: Quote, route: QuoteRoute, rideId: string, clientRecord: unknown): Promise<AcceptResult> {
  await call('accept_quote', {
    quote_id: quote.id,
    ride_id: rideId,
    client_record: JSON.stringify(clientRecord),
    pickup_lat: route.pickup.coord.lat,
    pickup_lng: route.pickup.coord.lng,
    dropoff_lat: route.dropoff.coord.lat,
    dropoff_lng: route.dropoff.coord.lng,
    distance_m: Math.round(route.distanceMeters),
  })
  const [row] = await call<{ status: string; ride_id: string | null }[]>('get_quote', { quote_id: quote.id })
  if (row?.status === 'accepted' && row.ride_id === rideId) return { ok: true, rideId }
  if (row?.status === 'expired') return { ok: false, reason: 'expired' }
  if (row?.status === 'superseded') return { ok: false, reason: 'changed' }
  return { ok: false, reason: 'unavailable' }
}

/** Whether operations have paused new ride requests (an outage lever). Unknown counts as running. */
export async function dispatchPaused(): Promise<boolean> {
  try {
    const [row] = await call<{ dispatch_paused: number }[]>('get_service_status')
    return row?.dispatch_paused === 1
  } catch {
    return false
  }
}

export const PAUSED_TEXT = 'New ride requests are paused for a short time while we fix a problem. Please try again in a few minutes.'
