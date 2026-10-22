import { expect, test } from '@playwright/test'
import { JOURNEYS, tag, type Journey } from '../matrix'
import { Actor, ORIGIN, RUN, ROUTE, cleanup, env, eventually, goOnline, missing, north, onboardDriver, requestRide, sleep, trail, tripOf } from '../lib/live'

// Issue #17: the live journey matrix. Drives the DEPLOYED app's actions with one throwaway account per
// role (rider, driver, second driver, staff). See docs/e2e-matrix.md for the journeys, the accounts and
// how a failure maps to an issue. Journeys share the accounts, so they run one at a time, in order,
// and each starts from a clean state.
type Row = Record<string, unknown>
const j = (id: string) => JOURNEYS.find((x) => x.id === id) as Journey

test.describe.configure({ mode: 'serial', retries: 0 })

let rider: Actor
let d1: Actor
let d2: Actor | undefined
let ops: Actor
const rides: string[] = []

const lacking = missing(true)
const SKIP_ALL = missing(false).length > 0

test.beforeAll(async () => {
  if (SKIP_ALL) return
  rider = await new Actor('rider', env.rider).init()
  d1 = await new Actor('driver', env.driver).init()
  ops = await new Actor('ops', env.ops).init()
  if (env.driver2) d2 = await new Actor('driver2', env.driver2).init()
  const ids = [rider.id, d1.id, ops.id, d2?.id].filter(Boolean)
  if (new Set(ids).size !== ids.length) throw new Error('The E2E accounts must be four different users (rider, driver, driver2, ops)')
  // Start from nothing: a crashed earlier run may have left data behind.
  await cleanup({ rider, drivers: [d1, ...(d2 ? [d2] : [])], rides: [] })
  await onboardDriver(d1, ops, ORIGIN, 'a')
  if (d2) await onboardDriver(d2, ops, north(2), 'b')
})

test.beforeEach(async ({}, info) => {
  trail.length = 0
  const joined = j(info.title.slice(0, 2))
  test.skip(SKIP_ALL, `no E2E accounts configured (missing ${missing(false).join(', ')}); see docs/e2e-matrix.md`)
  test.skip(Boolean(joined.needsSecondDriver) && lacking.length > 0, `needs ${lacking.join(', ')}`)
  test.skip(Boolean(joined.slow) && !env.slow, 'slow journey: set E2E_SLOW=1 to wait real minutes')
  // Independent journeys: close anything the last one left open and bring the drivers back online.
  for (const r of rides.splice(0)) await rider.tryCall('cancel_ride', { request_id: r, reason_code: 'other', note: '[e2e] reset' })
  await goOnline(d1, ORIGIN, 'a')
  if (d2) await goOnline(d2, north(2), 'b')
})

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && trail.length > 0) {
    // The artifact a failure needs: every action in order, with status, timing, inputs and what came back.
    await info.attach('action-trail.json', { body: JSON.stringify(trail, null, 2), contentType: 'application/json' })
    info.annotations.push({ type: 'owner', description: j(info.title.slice(0, 2)).issues.map((n) => `#${n}`).join(' ') })
  }
})

test.afterAll(async () => {
  if (SKIP_ALL) return
  const problems = await cleanup({ rider, drivers: [d1, ...(d2 ? [d2] : [])], rides })
  if (problems.length) console.warn(`E2E cleanup problems (run ${RUN}):\n  ${problems.join('\n  ')}`)
})

const status = async (ride: string) => ((await rider.call<Row[]>('get_dispatch_status', { request_id: ride }))[0] ?? {}) as Row
const lifecycle = async (ride: string) => ((await rider.call<Row[]>('get_my_trip_lifecycle', { request_id: ride }))[0] ?? {}) as Row
const offerFor = async (driver: Actor, ride: string) => (await driver.call<Row[]>('list_my_offers')).find((o) => o.request_id === ride)

/** Tick dispatch until the driver holds a live offer for this ride. */
const offered = (driver: Actor, ride: string) =>
  eventually(`${driver.name} is offered ${ride}`, async () => {
    await rider.call('dispatch_tick', { request_id: ride })
    const o = await offerFor(driver, ride)
    return o?.status === 'offered' ? o : null
  })

async function matched(label: string, driver = d1) {
  const r = await requestRide(rider, label)
  expect(r.accepted, 'the quote was accepted and became a ride').toBe(true)
  rides.push(r.rideId)
  await offered(driver, r.rideId)
  await driver.call('accept_offer', { rider_id: rider.id, request_id: r.rideId })
  await eventually('the ride is matched', async () => (await status(r.rideId)).status === 'matched')
  return r.rideId
}

test(tag(j('J1')), async () => {
  test.setTimeout(180_000)
  const ride = await matched('j1')
  const trip = tripOf(ride)
  expect((await status(ride)).driver_name, 'the rider sees the driver once they accepted').toBeTruthy()

  await d1.call('advance_trip', { rider_id: rider.id, trip_id: trip, to_status: 'en_route' })
  await d1.call('publish_driver_location', { rider_id: rider.id, trip_id: trip, ...north(1), accuracy_m: 8, speed_mps: 8 })
  const seen = await eventually('the rider sees the driver position', async () => (await rider.call<Row[]>('get_driver_location', { request_id: ride }))[0])
  expect(seen.age_ms as number).toBeLessThan(60_000)
  expect((await lifecycle(ride)).phase).toBe('en_route')

  await d1.call('advance_trip', { rider_id: rider.id, trip_id: trip, to_status: 'arrived' })
  await d1.call('start_trip', { rider_id: rider.id, trip_id: trip })
  expect((await lifecycle(ride)).phase).toBe('in_progress')
  await d1.call('advance_trip', { rider_id: rider.id, trip_id: trip, to_status: 'completed' })

  const done = await lifecycle(ride)
  expect(done).toMatchObject({ phase: 'completed', outcome: 'completed' })
  const [receipt] = await rider.call<Row[]>('get_receipt', { request_id: ride })
  expect(receipt?.receipt_no, 'a receipt was written when the trip ended').toBeTruthy()
  expect(receipt.final_cents as number).toBeGreaterThan(0)
  expect(await rider.call<Row[]>('get_driver_location', { request_id: ride }), 'tracking stops when the trip ends').toEqual([])
  expect(await offerFor(d1, ride), 'the driver is released').toBeUndefined()
})

test(tag(j('J2')), async () => {
  test.setTimeout(240_000)
  // Take every test driver offline: nobody is available at the pickup.
  await d1.call('set_driver_availability', { available: 0 })
  if (d2) await d2.call('set_driver_availability', { available: 0 })

  // (a) A priced quote is not accepted when no driver is eligible, and nothing is created.
  const refused = await requestRide(rider, 'j2a')
  expect(refused.accepted, 'a quote cannot be accepted with no driver').toBe(false)
  expect(await rider.call<Row[]>('get_quote', { quote_id: refused.quoteId })).toMatchObject([{ status: expect.stringMatching(/pending|expired|superseded/) }])
  expect(await rider.call<Row[]>('get_dispatch_status', { request_id: refused.rideId })).toEqual([])

  // (b) A search that finds nobody ends in no_driver once its 2 minute window is over, and can be restarted.
  const ride = `${RUN}-j2b`
  rides.push(ride)
  await rider.call('save_ride', {
    request_id: ride, booking_type: 'now', request_status: 'open', pickup_label: ROUTE.pickup_label, pickup_lat: ROUTE.pickup_lat, pickup_lng: ROUTE.pickup_lng,
    dropoff_label: ROUTE.dropoff_label, dropoff_lat: ROUTE.dropoff_lat, dropoff_lng: ROUTE.dropoff_lng, recurring_days: null, pickup_time: null, scheduled_for: null,
    vehicle_class: 'share', requested_at: Date.now(), client_record: JSON.stringify({ id: ride, e2e: RUN }), created_at: Date.now(),
    driver_id: null, driver_name: null, driver_rating: null, vehicle_id: null, vehicle_plate: null, quote_id: null, fare_cents: null, eta_minutes: null,
    assignment_id: null, trip_id: null, trip_status: null, trip_event_id: null,
  })
  await rider.call('request_dispatch', { request_id: ride })
  await rider.call('dispatch_tick', { request_id: ride })
  expect((await status(ride)).status).toBe('searching')
  await sleep(122_000)
  await rider.call('dispatch_tick', { request_id: ride })
  expect(await status(ride)).toMatchObject({ status: 'no_driver' })
  await d1.call('update_driver_location', { ...ORIGIN, service_radius_km: 10 })
  await d1.call('set_driver_availability', { available: 1, vehicle_id: 'v-a' })
  await rider.call('request_dispatch', { request_id: ride })
  await offered(d1, ride)
})

test(tag(j('J3')), async () => {
  test.setTimeout(120_000)
  const second = d2 as Actor
  const r = await requestRide(rider, 'j3')
  expect(r.accepted).toBe(true)
  rides.push(r.rideId)
  await offered(d1, r.rideId) // d1 is at the pickup, d2 is 2 km away: the nearer driver is asked first
  expect(await offerFor(second, r.rideId)).toBeUndefined()
  await d1.call('decline_offer', { rider_id: rider.id, request_id: r.rideId })
  await offered(second, r.rideId)
  expect(await offerFor(d1, r.rideId), 'the decliner is not asked again').toBeUndefined()
  await second.call('accept_offer', { rider_id: rider.id, request_id: r.rideId })
  await eventually('matched to the second driver', async () => (await status(r.rideId)).status === 'matched')
  const [trip] = await rider.call<Row[]>('get_my_trip_lifecycle', { request_id: r.rideId })
  expect(trip?.phase).toBe('scheduled')
})

test(tag(j('J4')), async () => {
  test.setTimeout(120_000)
  const ride = await matched('j4')
  await d1.call('advance_trip', { rider_id: rider.id, trip_id: tripOf(ride), to_status: 'en_route' })
  await rider.call('cancel_ride', { request_id: ride, reason_code: 'changed_plans', note: '[e2e] cancellation journey' })
  const ended = await lifecycle(ride)
  expect(ended).toMatchObject({ phase: 'cancelled', outcome: 'rider_cancelled', cancelled_by_role: 'rider', cancel_code: 'changed_plans' })
  expect(await rider.call<Row[]>('get_driver_location', { request_id: ride }), 'tracking stops').toEqual([])
  expect((await offerFor(d1, ride))?.status, 'the driver no longer holds the ride').not.toBe('accepted')
  // The driver is free again: a new request is offered to them.
  const next = await requestRide(rider, 'j4b')
  expect(next.accepted).toBe(true)
  rides.push(next.rideId)
  await offered(d1, next.rideId)
})

test(tag(j('J5')), async () => {
  test.setTimeout(120_000)
  const ride = await matched('j5')
  const trip = tripOf(ride)
  expect(await rider.call<Row[]>('get_driver_location', { request_id: ride }), 'no position before the driver starts').toEqual([])
  await d1.call('advance_trip', { rider_id: rider.id, trip_id: trip, to_status: 'en_route' })
  await d1.call('publish_driver_location', { rider_id: rider.id, trip_id: trip, ...north(1), accuracy_m: 8 })
  const first = (await eventually('a position', async () => (await rider.call<Row[]>('get_driver_location', { request_id: ride }))[0])) as Row
  await sleep(15_000) // the driver goes quiet: the app turns the growing age into "Delayed" and then "Last seen"
  const later = (await rider.call<Row[]>('get_driver_location', { request_id: ride }))[0]
  expect(later.age_ms as number, 'the server reports how old the position really is').toBeGreaterThanOrEqual((first.age_ms as number) + 12_000)
  expect(later.lat).toBe(first.lat)
  // A fresh position replaces it, not appends: still one row, age resets.
  await d1.call('publish_driver_location', { rider_id: rider.id, trip_id: trip, ...north(1.2), accuracy_m: 8 })
  const fresh = (await eventually('a fresh position', async () => {
    const [row] = await rider.call<Row[]>('get_driver_location', { request_id: ride })
    return row && (row.age_ms as number) < 10_000 ? row : null
  })) as Row
  expect(fresh.lat).not.toBe(first.lat)
})

test(tag(j('J6')), async () => {
  test.setTimeout(540_000)
  const ride = await matched('j6')
  await d1.call('advance_trip', { rider_id: rider.id, trip_id: tripOf(ride), to_status: 'en_route' })
  await d1.call('publish_driver_location', { rider_id: rider.id, trip_id: tripOf(ride), ...north(1), accuracy_m: 8 })
  const quiet = async () => (await ops.call<Row[]>('ops_health_alerts', { window_min: 15 })).find((a) => a.code === 'stale_tracking')
  expect((await quiet())?.firing, 'not stale while positions arrive').toBe(0)
  await sleep(5 * 60_000 + 20_000) // the alert fires after 5 minutes without a position on an active trip
  expect((await quiet())?.firing, 'stale_tracking is firing').toBe(1)
  expect(await quiet()).toMatchObject({ severity: 'critical', runbook: 'dispatch-outage' })
  await d1.call('publish_driver_location', { rider_id: rider.id, trip_id: tripOf(ride), ...north(1.1), accuracy_m: 8 })
  await eventually('the alert clears', async () => (await quiet())?.firing === 0, { timeoutMs: 20_000 })
})

test(tag(j('J7')), async () => {
  test.setTimeout(120_000)
  const ride = await matched('j7')
  const trip = tripOf(ride)
  await d1.call('advance_trip', { rider_id: rider.id, trip_id: trip, to_status: 'en_route' })
  await d1.call('publish_driver_location', { rider_id: rider.id, trip_id: trip, ...north(1), accuracy_m: 8 })
  const key = `${RUN}-report`
  await rider.call('submit_safety_report', { rider_id: rider.id, trip_id: trip, request_key: key, category: 'emergency', note: '[e2e] test report, please ignore' })
  const mine = (await rider.call<Row[]>('list_my_safety_reports')).find((r) => String(r.id).endsWith(`:${key}`))
  expect(mine, 'the rider can see their report').toMatchObject({ urgency: 'urgent', status: 'open', trip_phase: 'en_route' })

  const id = `${rider.id}:${key}`
  const queued = await eventually('staff see the report', async () => (await ops.call<Row[]>('ops_list_safety_reports', { limit: 100 })).find((r) => r.id === id))
  expect(queued).toMatchObject({ urgency: 'urgent', reporter_role: 'rider', subject_id: d1.id, subject_role: 'driver', trip_id: trip, category: 'emergency' })
  expect(JSON.stringify(queued), 'staff list carries no address or plate').not.toMatch(/\[e2e\] Pickup|E2EA/)
  expect((await ops.call<Row[]>('ops_list_escalations', { limit: 200 })).some((e) => e.id === `safety:${id}`), 'an urgent report opens a safety escalation').toBe(true)

  await ops.call('ops_update_safety_report', { report_id: id, status: 'in_review' })
  await ops.call('ops_update_safety_report', { report_id: id, status: 'resolved', resolution_code: 'no_action', note: '[e2e] automated test report' })
  expect((await ops.call<Row[]>('ops_list_safety_reports', { status: 'resolved', limit: 100 })).find((r) => r.id === id)).toMatchObject({ status: 'resolved', resolution_code: 'no_action' })
  expect((await ops.call<Row[]>('ops_list_escalations', { status: 'open', limit: 200 })).some((e) => e.id === `safety:${id}`), 'the escalation was closed with the report').toBe(false)
})

test(tag(j('J8')), async () => {
  test.setTimeout(120_000)
  try {
    await ops.call('ops_suspend_driver', { driver_user_id: d1.id, reason_code: 'other', note: '[e2e] suspension journey' })
    expect((await d1.call<Row[]>('get_my_driver_application'))[0]).toMatchObject({ status: 'suspended' })
    expect((await d1.call<Row[]>('get_my_driver_availability'))[0]?.available ?? 0, 'taken offline').toBe(0)
    expect((await ops.call<Row[]>('list_dispatchable_drivers', { limit: 200 })).some((d) => d.user_id === d1.id), 'not dispatchable').toBe(false)
    await d1.tryCall('set_driver_availability', { available: 1, vehicle_id: 'v-a' })
    expect((await d1.call<Row[]>('get_my_driver_availability'))[0]?.available ?? 0, 'cannot go available while suspended').toBe(0)

    // A request near the suspended driver is never offered to them.
    const r = await requestRide(rider, 'j8')
    if (r.accepted) {
      rides.push(r.rideId)
      for (let i = 0; i < 3; i++) { await rider.call('dispatch_tick', { request_id: r.rideId }); await sleep(1000) }
      expect(await offerFor(d1, r.rideId)).toBeUndefined()
    } else {
      expect(r.accepted, 'with the only eligible driver suspended there is nobody to quote against').toBe(false)
    }
  } finally {
    await ops.call('ops_reinstate_driver', { driver_user_id: d1.id, reason_code: 'review_complete', note: '[e2e] end of journey' })
  }
  expect((await d1.call<Row[]>('get_my_driver_application'))[0]).toMatchObject({ status: 'approved' })
  await goOnline(d1, ORIGIN, 'a')
})
