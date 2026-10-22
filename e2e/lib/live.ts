/**
 * Client for the LIVE app's actions, used by the journey matrix (issue #17). It speaks the same HTTP
 * the SDK does (POST /v1/apps/<app>/actions/<name> with a bearer session) so a journey exercises the
 * real server rules, with one throwaway account per role.
 *
 * Safety of live runs:
 * - every actor is a dedicated test account (its own session token), never a real person;
 * - pickups are in a remote area with no real drivers, so a test search cannot reach a real driver
 *   and a real search cannot reach a test driver;
 * - every record is created with a run id and free text starting "[e2e]";
 * - cleanup() cancels what is open and erases each account's data with the app's own erasure actions.
 *   Staff audit records (review log, escalations, safety reports, access log) are kept by design.
 */
export const API = process.env.E2E_API_BASE || 'https://api.proappstore.online'
export const APP = process.env.E2E_APP_ID || 'loopride'

export const RUN = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Antarctica, near Vostok Station. Valid coordinates that no real driver or rider will use. */
export const ORIGIN = { lat: -78.4644, lng: 106.835 }
export const north = (km: number) => ({ lat: ORIGIN.lat + km * 0.009, lng: ORIGIN.lng })
export const ROUTE = {
  pickup_label: '[e2e] Pickup', pickup_lat: ORIGIN.lat, pickup_lng: ORIGIN.lng,
  dropoff_label: '[e2e] Dropoff', dropoff_lat: ORIGIN.lat + 0.045, dropoff_lng: ORIGIN.lng,
  distance_m: 5000, duration_s: 600,
}

export interface Call { at: string; actor: string; action: string; status: number | 'network'; ms: number; params: unknown; result: unknown }
/** Every call of the current test, attached to the report on failure. Tokens are never recorded. */
export const trail: Call[] = []

export class ActionFailed extends Error {
  constructor(public action: string, public status: number, public body: string) {
    super(`${action} -> HTTP ${status}: ${body.slice(0, 300)}`)
  }
}

export class Actor {
  id = ''
  constructor(public name: string, private token: string) {}

  async init() {
    const res = await fetch(`${API}/v1/auth/me`, { headers: { Authorization: `Bearer ${this.token}` } })
    if (!res.ok) throw new Error(`${this.name}: session token rejected (HTTP ${res.status}). Re-issue the E2E token for this account.`)
    const body = (await res.json()) as { id?: string; user?: { id?: string } }
    this.id = body.user?.id ?? body.id ?? ''
    if (!this.id) throw new Error(`${this.name}: /v1/auth/me returned no user id`)
    return this
  }

  async call<T = Record<string, unknown>[]>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const started = Date.now()
    const entry: Call = { at: new Date(started).toISOString(), actor: this.name, action, status: 'network', ms: 0, params, result: null }
    trail.push(entry)
    try {
      const res = await fetch(`${API}/v1/apps/${APP}/actions/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ params }),
      })
      entry.status = res.status
      entry.ms = Date.now() - started
      const text = await res.text()
      if (!res.ok) {
        entry.result = text.slice(0, 500)
        throw new ActionFailed(action, res.status, text)
      }
      const json = text ? JSON.parse(text) : null
      entry.result = json
      return json as T
    } finally {
      entry.ms = Date.now() - started
    }
  }

  /** Like call, but a refusal is returned instead of thrown (the server answers refusals with no change, or an error). */
  async tryCall<T = Record<string, unknown>[]>(action: string, params: Record<string, unknown> = {}): Promise<T | null> {
    try {
      return await this.call<T>(action, params)
    } catch (e) {
      if (e instanceof ActionFailed) return null
      throw e
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll until `read` returns something truthy, or fail with what was last seen. */
export async function eventually<T>(what: string, read: () => Promise<T | null | undefined | false>, { timeoutMs = 30_000, everyMs = 1500 } = {}): Promise<T> {
  const until = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < until) {
    last = await read()
    if (last) return last as T
    await sleep(everyMs)
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}. Last seen: ${JSON.stringify(last)}`)
}

export const env = {
  rider: process.env.E2E_RIDER_TOKEN || process.env.E2E_SESSION_TOKEN || '',
  driver: process.env.E2E_DRIVER_TOKEN || '',
  driver2: process.env.E2E_DRIVER2_TOKEN || '',
  ops: process.env.E2E_OPS_TOKEN || '',
  slow: process.env.E2E_SLOW === '1',
}

export const missing = (needSecond: boolean) =>
  [['E2E_RIDER_TOKEN', env.rider], ['E2E_DRIVER_TOKEN', env.driver], ['E2E_OPS_TOKEN', env.ops], ...(needSecond ? [['E2E_DRIVER2_TOKEN', env.driver2]] : [])]
    .filter(([, v]) => !v)
    .map(([k]) => k)

type Row = Record<string, unknown>

/** Put a test driver through the real onboarding (apply, vehicle, submit, staff approval, consent) and online. */
export async function onboardDriver(driver: Actor, ops: Actor, at: { lat: number; lng: number }, tag: string) {
  const [app] = await driver.call<Row[]>('get_my_driver_application')
  const status = app?.status as string | undefined
  if (status === 'suspended') await ops.call('ops_reinstate_driver', { driver_user_id: driver.id, reason_code: 'other', note: '[e2e] reset before run' })
  if (status !== 'approved' && status !== 'suspended') {
    if (status !== 'submitted') {
      await driver.call('save_driver_application', { full_name: `[e2e] ${tag}`, phone: '000', licence_number: `E2E-${RUN}-${tag}`, licence_region: 'E2E', licence_expires: '2099-01-01', eligibility_confirmed: 1 })
      await driver.call('save_driver_vehicle', { vehicle_id: `v-${tag}`, plate: `E2E${tag}`.toUpperCase().slice(0, 8), make: 'Test', model: 'Car', vehicle_class: 'share' })
      await driver.call('submit_driver_application')
    }
    await ops.call('review_driver_application', { driver_user_id: driver.id, decision: 'approved' })
  }
  for (const purpose of ['dispatch_availability', 'trip_tracking']) await driver.call('set_location_consent', { purpose, granted: 1, notice_version: 'e2e' })
  await goOnline(driver, at, tag)
}

export async function goOnline(driver: Actor, at: { lat: number; lng: number }, tag: string) {
  await driver.call('update_driver_location', { ...at, service_radius_km: 10 })
  await driver.call('set_driver_availability', { available: 1, vehicle_id: `v-${tag}` })
  await eventually(`${driver.name} is available`, async () => {
    const [row] = await driver.call<Row[]>('get_my_driver_availability')
    return row?.available === 1
  })
}

/** Quote and accept a ride; returns the ride id. The quote is refused when no driver is eligible. */
export async function requestRide(rider: Actor, label: string): Promise<{ quoteId: string; rideId: string; accepted: boolean }> {
  const quoteId = `${RUN}-${label}-q`
  const rideId = `${RUN}-${label}`
  await rider.call('create_quote', { quote_id: quoteId, vehicle_class: 'share', ...ROUTE })
  await rider.call('accept_quote', {
    quote_id: quoteId, ride_id: rideId, client_record: JSON.stringify({ id: rideId, e2e: RUN }),
    pickup_lat: ROUTE.pickup_lat, pickup_lng: ROUTE.pickup_lng, dropoff_lat: ROUTE.dropoff_lat, dropoff_lng: ROUTE.dropoff_lng, distance_m: ROUTE.distance_m,
  })
  const [q] = await rider.call<Row[]>('get_quote', { quote_id: quoteId })
  return { quoteId, rideId, accepted: q?.status === 'accepted' && q?.ride_id === rideId }
}

export const tripOf = (rideId: string) => `${rideId}:trip`

/** Cancel whatever is open and erase the accounts' data. Never throws: a cleanup problem must not hide a test result. */
export async function cleanup(actors: { rider?: Actor; drivers: Actor[]; rides: string[] }) {
  const problems: string[] = []
  const attempt = async (what: string, fn: () => Promise<unknown>) => { try { await fn() } catch (e) { problems.push(`${what}: ${(e as Error).message}`) } }
  for (const ride of actors.rides) if (actors.rider) await attempt(`cancel ${ride}`, () => actors.rider!.tryCall('cancel_ride', { request_id: ride, reason_code: 'other', note: '[e2e] cleanup' }))
  for (const d of actors.drivers) await attempt(`offline ${d.name}`, () => d.tryCall('set_driver_availability', { available: 0 }))
  for (const d of actors.drivers) await attempt(`erase ${d.name}`, () => d.call('delete_my_driver_data'))
  for (const d of actors.drivers) await attempt(`erase ${d.name} (rider side)`, () => d.call('delete_my_rider_data'))
  if (actors.rider) await attempt('erase rider', async () => { await actors.rider!.call('delete_my_rider_data'); await actors.rider!.call('delete_my_driver_data') })
  return problems
}
