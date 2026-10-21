import { app } from './app'

/**
 * Dispatch client. Matching rules, locks and timeouts live in the mcp.json
 * actions (docs/domain-model.md › Dispatch); this file only calls them.
 */
export type DispatchState = 'searching' | 'matched' | 'no_driver' | 'cancelled'

export interface DispatchStatus {
  state: DispatchState
  attempts: number
  offerStatus: 'offered' | 'accepted' | null
  driverName: string | null
  plate: string | null
}

interface StatusRow {
  status: DispatchState
  attempts: number
  offer_status: 'offered' | 'accepted' | null
  driver_name: string | null
  plate: string | null
}

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

/** Squared distances come from SQL (SQLite has no guaranteed sqrt). */
export const kmFromSquared = (km2: number | null) => (km2 == null ? null : Math.sqrt(km2))

export const isTerminal = (state: DispatchState) => state !== 'searching'

// ---- rider ----

export async function getDispatchStatus(requestId: string): Promise<DispatchStatus | null> {
  const [row] = await call<StatusRow[]>('get_dispatch_status', { request_id: requestId })
  if (!row) return null
  return { state: row.status, attempts: row.attempts, offerStatus: row.offer_status, driverName: row.driver_name, plate: row.plate }
}

/** Start or restart the search. The ride must already be saved to the DB (await persistRide first). */
export const startDispatch = (requestId: string) => call('request_dispatch', { request_id: requestId })

export const dispatchTick = (requestId: string) => call('dispatch_tick', { request_id: requestId })

/**
 * Tick and poll until the search ends (matched, no_driver, cancelled), the
 * signal aborts, or the status disappears. Resolves with the final status.
 */
export async function runDispatch(
  requestId: string,
  opts: { intervalMs?: number; signal?: AbortSignal; onUpdate?: (s: DispatchStatus) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DispatchStatus | null> {
  const interval = opts.intervalMs ?? 4000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (;;) {
    if (opts.signal?.aborted) return null
    await dispatchTick(requestId)
    const status = await getDispatchStatus(requestId)
    if (!status) return null
    opts.onUpdate?.(status)
    if (isTerminal(status.state)) return status
    await sleep(interval)
  }
}

// ---- driver ----

export interface Offer {
  riderId: string
  requestId: string
  status: 'offered' | 'accepted'
  km: number | null
  expiresAt: number
  pickup: string
  dropoff: string
  vehicleClass: string | null
  fareCents: number | null
}

interface OfferRow {
  rider_id: string
  request_id: string
  status: 'offered' | 'accepted'
  distance_km2: number | null
  expires_at: number
  pickup_label: string
  dropoff_label: string
  vehicle_class: string | null
  fare_cents: number | null
}

export async function loadOffers(): Promise<Offer[]> {
  const rows = await call<OfferRow[]>('list_my_offers')
  return rows.map((r) => ({
    riderId: r.rider_id,
    requestId: r.request_id,
    status: r.status,
    km: kmFromSquared(r.distance_km2),
    expiresAt: r.expires_at,
    pickup: r.pickup_label,
    dropoff: r.dropoff_label,
    vehicleClass: r.vehicle_class,
    fareCents: r.fare_cents,
  }))
}

export const acceptOffer = (o: Pick<Offer, 'riderId' | 'requestId'>) => call('accept_offer', { rider_id: o.riderId, request_id: o.requestId })
export const declineOffer = (o: Pick<Offer, 'riderId' | 'requestId'>) => call('decline_offer', { rider_id: o.riderId, request_id: o.requestId })

export const SERVICE_RADIUS_OPTIONS_KM = [2, 5, 10, 25] as const

export const publishLocation = (lat: number, lng: number, serviceRadiusKm: number) =>
  call('update_driver_location', { lat, lng, service_radius_km: serviceRadiusKm })

export async function loadLocation(): Promise<{ lat: number; lng: number; radiusKm: number } | null> {
  const [row] = await call<{ lat: number; lng: number; service_radius_km: number }[]>('get_my_driver_location')
  return row ? { lat: row.lat, lng: row.lng, radiusKm: row.service_radius_km } : null
}

/** Current device position, or null when unavailable or denied. */
export function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  })
}
