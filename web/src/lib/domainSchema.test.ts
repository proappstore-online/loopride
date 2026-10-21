// @vitest-environment node
import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it } from 'vitest'
import migrationsFile from '../../../migrations.json'
import mcpFile from '../../../mcp.json'
import type { RecurringRide } from '../types'
import { rideToRecords } from './rideRecords'

// Runs the committed migrations.json + mcp.json against a real SQLite (D1 is
// SQLite), binding params the way the platform action executor does.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

interface ParamSpec {
  type: string
  optional?: boolean
  default?: unknown
}
interface Tool {
  name: string
  operation: 'query' | 'execute' | 'batch'
  sql?: string
  statements?: string[]
  params?: Record<string, ParamSpec>
  requires_auth: boolean
}
type Db = InstanceType<typeof DatabaseSync>

const tools = mcpFile.tools as Tool[]
const tool = (name: string) => tools.find((t) => t.name === name)!
const statementsOf = (t: Tool) => t.statements ?? [t.sql!]
const placeholders = (sql: string) => [...sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1])
const MAGIC = ['__user_id', '__now', '__uuid']

function migrate(db: Db, applied: Set<string>) {
  for (const m of migrationsFile.migrations) {
    if (applied.has(m.name)) continue
    db.exec(m.sql)
    applied.add(m.name)
  }
}

function call(db: Db, name: string, params: Record<string, unknown>, userId: string, now = 1_000) {
  const t = tool(name)
  const bound: Record<string, unknown> = { __user_id: userId, __now: now, __uuid: crypto.randomUUID() }
  for (const [key, spec] of Object.entries(t.params ?? {})) {
    const value = params[key]
    if (value === undefined || value === null) {
      if ('default' in spec) bound[key] = spec.default
      else if (spec.optional) bound[key] = null
      else throw new Error(`Missing required parameter: ${key}`)
    } else {
      if (spec.type === 'integer' && !Number.isInteger(value)) throw new Error(`${key} must be an integer`)
      bound[key] = value
    }
  }
  const bind = (sql: string) => Object.fromEntries(placeholders(sql).map((p) => [p, bound[p]]))
  if (t.operation === 'query') return db.prepare(t.sql!).all(bind(t.sql!))
  db.exec('BEGIN')
  try {
    for (const sql of statementsOf(t)) db.prepare(sql).run(bind(sql))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const TABLES = ['riders', 'drivers', 'vehicles', 'ride_requests', 'quotes', 'assignments', 'trips', 'trip_events']
const snapshot = (db: Db) =>
  Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]))

/** A pre-RideShare Loopride record: none of the newer optional fields. */
const legacyRide: RecurringRide = {
  id: 'legacy-1',
  pickup: '12 Home St',
  pickupCoord: { lat: -33.8688, lng: 151.2093 },
  dropoff: 'Central School',
  dropoffCoord: { lat: -33.857, lng: 151.215 },
  days: ['mon', 'wed', 'fri'],
  time: '08:15',
  driverName: 'Alex Smith',
  paused: true,
  createdAt: 1_700_000_000_000,
  routePolyline: [
    [151.2093, -33.8688],
    [151.215, -33.857],
  ],
}

/** A current on-demand RideShare ride, mid-trip. */
const onDemandRide: RecurringRide = {
  id: 'now-1',
  pickup: 'Central Station',
  pickupCoord: { lat: -33.883, lng: 151.206 },
  dropoff: 'Opera House',
  dropoffCoord: null,
  days: [],
  time: '09:00',
  driverName: 'Jordan',
  paused: false,
  createdAt: 1_700_000_100_000,
  requestedAt: 1_700_000_100_000,
  bookingType: 'now',
  vehicle: 'comfort',
  fareCents: 2450,
  etaMinutes: 7,
  driverPlate: 'RS-482',
  driverRating: 4.9,
  status: 'en-route',
}

describe('committed manifests satisfy the platform registration rules', () => {
  it('every action statement is a single caller-scoped statement with declared params', () => {
    for (const t of tools) {
      expect(t.requires_auth, t.name).toBe(true)
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/)
      for (const sql of statementsOf(t)) {
        expect(sql, t.name).not.toContain(';')
        expect(sql, t.name).toContain(':__user_id')
        expect(sql, t.name).not.toMatch(/\b(CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/i)
        const verb = sql.trim().split(/\s+/)[0].toUpperCase()
        expect(['SELECT', 'INSERT', 'UPDATE', 'DELETE'], t.name).toContain(verb)
        if (verb === 'UPDATE' || verb === 'DELETE') expect(sql.toUpperCase()).toContain('WHERE')
        for (const p of placeholders(sql)) {
          expect(MAGIC.includes(p) || p in (t.params ?? {}), `${t.name}: :${p} undeclared`).toBe(true)
        }
      }
    }
  })

  it('stays inside the platform registration limits (the #9 deploy was rejected at 26 statements)', () => {
    expect(tools.length).toBeLessThanOrEqual(120)
    for (const t of tools) expect((t.statements ?? []).length, t.name).toBeLessThanOrEqual(25)
  })

  it('migrations are additive only', () => {
    for (const m of migrationsFile.migrations) {
      for (const stmt of m.sql.split(';').map((s) => s.trim()).filter(Boolean)) {
        expect(stmt).toMatch(/^CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/i)
        expect(stmt).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|REPLACE)\b/i)
      }
    }
  })

  it('save_ride declares exactly the params the client sends', () => {
    expect(Object.keys(tool('save_ride').params ?? {}).sort()).toEqual(
      Object.keys(rideToRecords(onDemandRide)).sort(),
    )
  })
})

describe('domain schema + legacy ride migration', () => {
  let db: Db
  let applied: Set<string>

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    applied = new Set()
    migrate(db, applied)
  })

  it('schema migration is idempotent', () => {
    migrate(db, applied) // tracked re-run (platform _migrations)
    for (const m of migrationsFile.migrations) db.exec(m.sql) // untracked re-run
    expect(count(db, 'ride_requests')).toBe(0)
  })

  it('migrates a legacy Loopride ride without data loss', () => {
    call(db, 'save_ride', { ...rideToRecords(legacyRide) }, 'user-a')

    const row = db.prepare('SELECT * FROM ride_requests WHERE id = ?').get('legacy-1') as Record<string, unknown>
    expect(JSON.parse(row.client_record as string)).toEqual(legacyRide)
    expect(row).toMatchObject({
      rider_id: 'user-a',
      booking_type: 'recurring',
      status: 'paused',
      pickup_label: '12 Home St',
      pickup_lat: -33.8688,
      dropoff_label: 'Central School',
      recurring_days: 'mon,wed,fri',
      pickup_time: '08:15',
      created_at: legacyRide.createdAt,
    })
    expect(db.prepare('SELECT display_name FROM drivers').all()).toEqual([{ display_name: 'Alex Smith' }])
    expect(count(db, 'assignments')).toBe(1)
    // Legacy rides had no fare, plate or trip progress — no rows invented.
    expect(count(db, 'quotes')).toBe(0)
    expect(count(db, 'vehicles')).toBe(0)
    expect(count(db, 'trips')).toBe(0)
    expect(count(db, 'riders')).toBe(1)
  })

  it('persists every entity for an on-demand ride', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a')
    expect(db.prepare('SELECT fare_cents, eta_minutes, vehicle_class, status FROM quotes').get()).toEqual({
      fare_cents: 2450,
      eta_minutes: 7,
      vehicle_class: 'comfort',
      status: 'accepted',
    })
    expect(db.prepare('SELECT plate, driver_id FROM vehicles').get()).toEqual({ plate: 'RS-482', driver_id: 'drv_jordan' })
    expect(db.prepare('SELECT status, assignment_id FROM trips').get()).toEqual({
      status: 'en_route',
      assignment_id: 'now-1:assignment',
    })
    expect(db.prepare('SELECT type, status FROM trip_events').all()).toEqual([{ type: 'status', status: 'en_route' }])
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'matched' })
  })

  it('re-running the migration changes nothing', () => {
    for (const ride of [legacyRide, onDemandRide]) call(db, 'save_ride', { ...rideToRecords(ride) }, 'user-a', 1_000)
    const first = snapshot(db)
    for (const ride of [legacyRide, onDemandRide]) call(db, 'save_ride', { ...rideToRecords(ride) }, 'user-a', 1_000)
    expect(snapshot(db)).toEqual(first)
  })

  it('records each trip status transition once', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a')
    call(db, 'save_ride', { ...rideToRecords({ ...onDemandRide, status: 'arrived' }) }, 'user-a', 2_000)
    call(db, 'save_ride', { ...rideToRecords({ ...onDemandRide, status: 'arrived' }) }, 'user-a', 3_000)
    expect(db.prepare('SELECT status, at FROM trip_events ORDER BY at').all()).toEqual([
      { status: 'en_route', at: 1_000 },
      { status: 'arrived', at: 2_000 },
    ])
    expect(count(db, 'trips')).toBe(1)
  })

  it('keeps riders isolated even when ride ids collide', () => {
    call(db, 'save_ride', { ...rideToRecords(legacyRide) }, 'user-a')
    call(db, 'save_ride', { ...rideToRecords({ ...legacyRide, pickup: 'Other home' }) }, 'user-b')
    const rows = db.prepare('SELECT rider_id, pickup_label FROM ride_requests ORDER BY rider_id').all()
    expect(rows).toEqual([
      { rider_id: 'user-a', pickup_label: '12 Home St' },
      { rider_id: 'user-b', pickup_label: 'Other home' },
    ])
    expect(call(db, 'list_ride_requests', {}, 'user-b')).toHaveLength(1)
  })

  it('cancel is a soft delete that a re-save (undo) reopens', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a')
    call(db, 'cancel_ride', { request_id: 'now-1' }, 'user-b') // not theirs — no effect
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'matched' })

    call(db, 'cancel_ride', { request_id: 'now-1' }, 'user-a')
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'cancelled' })
    expect(db.prepare('SELECT status FROM trips').get()).toEqual({ status: 'cancelled' })

    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a')
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'matched' })
  })
})

describe('trip persistence and transition history', () => {
  let db: Db

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const history = (tripId = 'now-1:trip') =>
    db.prepare('SELECT from_status, to_status, actor_type, actor_id, metadata, at FROM trip_transitions WHERE trip_id = ? ORDER BY at, rowid').all(tripId)
  const tripStatus = () => (db.prepare('SELECT status FROM trips').get() as { status: string }).status
  /** Link the ride's driver to a PAS account (the claim flow is not built yet). */
  const linkDriver = (userId: string) => db.prepare('UPDATE drivers SET user_id = ?').run(userId)
  const advance = (userId: string, to: string, metadata?: string, riderId = 'user-a', now = 5_000) =>
    call(db, 'advance_trip', { rider_id: riderId, trip_id: 'now-1:trip', to_status: to, metadata }, userId, now)

  it('records actor, timestamp and metadata for rider-synced transitions', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    call(db, 'save_ride', { ...rideToRecords({ ...onDemandRide, status: 'arrived' }) }, 'user-a', 2_000)
    expect(history()).toEqual([
      { from_status: null, to_status: 'en_route', actor_type: 'rider', actor_id: 'user-a', metadata: '{"source":"save_ride"}', at: 1_000 },
      { from_status: 'en_route', to_status: 'arrived', actor_type: 'rider', actor_id: 'user-a', metadata: '{"source":"save_ride"}', at: 2_000 },
    ])
  })

  it('replaying saves does not duplicate history', () => {
    for (const now of [1_000, 2_000, 3_000]) call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', now)
    expect(history()).toHaveLength(1)
    expect(count(db, 'trip_events')).toBe(1)
  })

  it('save_ride never moves a trip backwards or out of a terminal state', () => {
    call(db, 'save_ride', { ...rideToRecords({ ...onDemandRide, status: 'arrived' }) }, 'user-a', 1_000)
    call(db, 'save_ride', { ...rideToRecords({ ...onDemandRide, status: 'en-route' }) }, 'user-a', 2_000)
    expect(tripStatus()).toBe('arrived')
    call(db, 'save_ride', { ...rideToRecords({ ...onDemandRide, status: 'completed' }) }, 'user-a', 3_000)
    call(db, 'save_ride', { ...rideToRecords({ ...onDemandRide, status: 'arrived' }) }, 'user-a', 4_000)
    expect(tripStatus()).toBe('completed')
    expect(history().map((h) => (h as { to_status: string }).to_status)).toEqual(['arrived', 'completed'])
    expect(count(db, 'trip_events')).toBe(2)
  })

  it('cancel_ride records a cancelled transition only for unfinished trips', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    call(db, 'cancel_ride', { request_id: 'now-1' }, 'user-b', 2_000)
    expect(history()).toHaveLength(1)
    call(db, 'cancel_ride', { request_id: 'now-1' }, 'user-a', 3_000)
    call(db, 'cancel_ride', { request_id: 'now-1' }, 'user-a', 4_000)
    expect(history()[1]).toMatchObject({ from_status: 'en_route', to_status: 'cancelled', actor_type: 'rider', actor_id: 'user-a', at: 3_000 })
    expect(history()).toHaveLength(2)
    expect(tripStatus()).toBe('cancelled')
  })

  it('a linked driver advances the trip one valid step at a time', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    linkDriver('driver-1')
    advance('driver-1', 'completed') // skips arrived — invalid
    expect(tripStatus()).toBe('en_route')
    advance('driver-1', 'arrived', '{"lat":-33.86}', 'user-a', 2_000)
    advance('driver-1', 'arrived', undefined, 'user-a', 2_500) // replay — no-op
    advance('driver-1', 'completed', undefined, 'user-a', 2_700) // not started yet — refused
    expect(tripStatus()).toBe('arrived')
    call(db, 'start_trip', { rider_id: 'user-a', trip_id: 'now-1:trip' }, 'driver-1', 2_800)
    advance('driver-1', 'completed', undefined, 'user-a', 3_000)
    advance('driver-1', 'en_route', undefined, 'user-a', 4_000) // terminal — no-op
    expect(tripStatus()).toBe('completed')
    expect(history().slice(1)).toEqual([
      { from_status: 'en_route', to_status: 'arrived', actor_type: 'driver', actor_id: 'driver-1', metadata: '{"lat":-33.86}', at: 2_000 },
      { from_status: 'arrived', to_status: 'completed', actor_type: 'driver', actor_id: 'driver-1', metadata: '{"source":"driver"}', at: 3_000 },
    ])
    expect(db.prepare('SELECT status FROM trip_events ORDER BY at').all().map((e) => (e as { status: string }).status)).toEqual([
      'en_route',
      'arrived',
      'completed',
    ])
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'completed' })
  })

  it('advance_trip is refused for anyone but the assigned driver', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    linkDriver('driver-1')
    advance('driver-2', 'arrived') // other driver
    advance('user-a', 'arrived') // the rider is not the driver
    advance('driver-1', 'arrived', undefined, 'user-b') // wrong rider scope
    expect(tripStatus()).toBe('en_route')
    expect(history()).toHaveLength(1)
  })

  it('a driver can cancel, which cancels the ride request', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    linkDriver('driver-1')
    call(db, 'driver_cancel_trip', { rider_id: 'user-a', trip_id: 'now-1:trip', reason_code: 'vehicle_issue' }, 'driver-1', 5_000)
    expect(tripStatus()).toBe('cancelled')
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'cancelled' })
    expect(history()[1]).toMatchObject({ to_status: 'cancelled', actor_type: 'driver' })
  })

  it('rider queries are scoped to the caller', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    expect(call(db, 'list_my_trips', {}, 'user-a')).toMatchObject([{ id: 'now-1:trip', status: 'en_route', pickup_label: 'Central Station' }])
    expect(call(db, 'list_my_trips', { status: 'completed' }, 'user-a')).toEqual([])
    expect(call(db, 'list_my_trips', {}, 'user-b')).toEqual([])
    expect(call(db, 'get_my_trip_history', { trip_id: 'now-1:trip' }, 'user-a')).toHaveLength(1)
    expect(call(db, 'get_my_trip_history', { trip_id: 'now-1:trip' }, 'user-b')).toEqual([])
  })

  it('driver queries only see trips assigned to the linked account', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    expect(call(db, 'list_driver_trips', {}, 'driver-1')).toEqual([]) // not linked yet
    linkDriver('driver-1')
    expect(call(db, 'list_driver_trips', {}, 'driver-1')).toMatchObject([{ rider_id: 'user-a', id: 'now-1:trip', status: 'en_route' }])
    expect(call(db, 'list_driver_trips', {}, 'driver-2')).toEqual([])
    const args = { rider_id: 'user-a', trip_id: 'now-1:trip' }
    expect(call(db, 'get_driver_trip_history', args, 'driver-1')).toHaveLength(1)
    expect(call(db, 'get_driver_trip_history', args, 'driver-2')).toEqual([])
    expect(call(db, 'get_driver_trip_history', args, 'user-a')).toEqual([])
  })
})

describe('rider account data', () => {
  let db: Db

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const profile = { display_name: 'Sam', phone: '555', notify_email: 1, notify_sms: 0, notify_trip_updates: 1 }

  it('upserts one profile per rider and scopes reads to the caller', () => {
    call(db, 'save_rider_profile', profile, 'user-a', 1_000)
    call(db, 'save_rider_profile', { ...profile, display_name: 'Sam B', notify_sms: 1 }, 'user-a', 2_000)
    call(db, 'save_rider_profile', { ...profile, display_name: 'Other' }, 'user-b', 2_000)
    expect(call(db, 'get_rider_profile', {}, 'user-a')).toEqual([
      { display_name: 'Sam B', phone: '555', notify_email: 1, notify_sms: 1, notify_trip_updates: 1, updated_at: 2_000 },
    ])
    expect(count(db, 'rider_profiles')).toBe(2)
    expect(call(db, 'get_rider_profile', {}, 'user-c')).toEqual([])
  })

  it('rejects non-boolean preference flags', () => {
    expect(() => call(db, 'save_rider_profile', { ...profile, notify_sms: 2 }, 'user-a')).toThrow()
  })

  it('saved places are per rider; ids cannot be hijacked across riders', () => {
    const place = { place_id: 'p1', label: 'Home', address: '1 Main St' }
    call(db, 'save_place', place, 'user-a', 1_000)
    call(db, 'save_place', { ...place, label: 'Mine' }, 'user-b', 1_000)
    call(db, 'save_place', { ...place, address: '2 Main St' }, 'user-a', 2_000)
    expect(call(db, 'list_saved_places', {}, 'user-a')).toMatchObject([{ id: 'p1', label: 'Home', address: '2 Main St' }])
    call(db, 'delete_place', { place_id: 'p1' }, 'user-b')
    expect(call(db, 'list_saved_places', {}, 'user-a')).toHaveLength(1)
    expect(call(db, 'list_saved_places', {}, 'user-b')).toHaveLength(0)
  })

  it('trip history exposes status, trip status and fare for the caller only', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    call(db, 'save_ride', { ...rideToRecords(legacyRide) }, 'user-a', 1_100)
    call(db, 'cancel_ride', { request_id: 'now-1' }, 'user-a', 2_000)
    const rows = call(db, 'list_trip_history', {}, 'user-a') as Record<string, unknown>[]
    expect(rows.find((r) => r.id === 'now-1')).toMatchObject({ status: 'cancelled', trip_status: 'cancelled', fare_cents: 2450 })
    expect(rows.find((r) => r.id === 'legacy-1')).toMatchObject({ booking_type: 'recurring', trip_status: null, fare_cents: null })
    expect(call(db, 'list_trip_history', {}, 'user-b')).toEqual([])
  })

  it('export returns only the caller\'s rows', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    call(db, 'save_ride', { ...rideToRecords(legacyRide) }, 'user-b', 1_000)
    expect(call(db, 'export_ride_requests', {}, 'user-a')).toHaveLength(1)
    expect(call(db, 'export_trips', {}, 'user-a')).toHaveLength(1)
    expect(call(db, 'export_trip_transitions', {}, 'user-a')).toHaveLength(1)
    expect(call(db, 'export_trips', {}, 'user-b')).toHaveLength(0)
    expect(JSON.parse((call(db, 'export_ride_requests', {}, 'user-a') as { client_record: string }[])[0].client_record)).toEqual(onDemandRide)
  })

  it('deleting a rider erases all their rows and leaves other riders untouched', () => {
    for (const user of ['user-a', 'user-b']) {
      call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, user, 1_000)
      call(db, 'save_rider_profile', profile, user)
      call(db, 'save_place', { place_id: 'p1', label: 'Home', address: 'x' }, user)
    }
    const before = snapshot(db)
    call(db, 'delete_my_rider_data', {}, 'user-a')
    for (const table of [...TABLES, 'trip_transitions', 'rider_profiles', 'saved_places']) {
      const col = table === 'riders' ? 'id' : 'rider_id'
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 'user-a'`).get(), table).toEqual({ n: 0 })
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 'user-b'`).get() as { n: number }).n, table).toBeGreaterThan(0)
    }
    const after = snapshot(db)
    for (const t of TABLES) expect(after[t], t).toEqual((before[t] as { rider_id?: string; id: string }[]).filter((r) => (t === 'riders' ? r.id : r.rider_id) === 'user-b'))
  })

  it('deleting a driver\'s account unlinks them from other riders\' trips but keeps those riders\' data', () => {
    call(db, 'save_ride', { ...rideToRecords(onDemandRide) }, 'user-a', 1_000)
    db.prepare('UPDATE drivers SET user_id = ?').run('driver-1')
    expect(call(db, 'list_driver_trips', {}, 'driver-1')).toHaveLength(1)
    call(db, 'delete_my_driver_data', {}, 'driver-1')
    expect(call(db, 'list_driver_trips', {}, 'driver-1')).toEqual([])
    expect(count(db, 'trips')).toBe(1)
  })
})

describe('driver onboarding, approval and dispatch eligibility', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const application = {
    full_name: 'Dana Driver',
    phone: '555-0100',
    licence_number: 'D1234567',
    licence_region: 'NSW',
    licence_expires: '2030-01-01',
    eligibility_confirmed: 1,
  }
  const vehicle = { vehicle_id: 'v1', plate: 'RS-482', make: 'Toyota', model: 'Camry', year: 2022, colour: 'white', seats: 4, vehicle_class: 'comfort' }
  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)
  const appStatus = (user = 'drv') => (db.prepare('SELECT status FROM driver_applications WHERE user_id = ?').get(user) as { status: string } | undefined)?.status
  const vehicleStatus = (id = 'v1') => (db.prepare('SELECT status FROM driver_vehicles WHERE id = ?').get(id) as { status: string }).status
  const review = (decision: string, reason?: string, actor = 'ops-1', now = NOW) =>
    as(actor, 'review_driver_application', { driver_user_id: 'drv', decision, reason }, now)
  const suspend = (note = 'complaint', actor = 'ops-1', code = 'complaint', id = 'drv') => as(actor, 'ops_suspend_driver', { driver_user_id: id, reason_code: code, note })
  const reinstate = (note = 'cleared', actor = 'ops-1', code = 'review_complete', id = 'drv') => as(actor, 'ops_reinstate_driver', { driver_user_id: id, reason_code: code, note })
  const submitted = () => {
    as('drv', 'save_driver_application', application)
    as('drv', 'save_driver_vehicle', vehicle)
    as('drv', 'submit_driver_application')
  }
  const approved = () => {
    submitted()
    review('approved')
  }
  const dispatchable = () => as('ops-1', 'list_dispatchable_drivers')
  const goAvailable = (now = NOW) => as('drv', 'set_driver_availability', { available: 1, vehicle_id: 'v1' }, now)

  it('ops tools are gated by the ops app role; applicant tools are not', () => {
    const opsTools = ['list_driver_applications', 'list_driver_vehicles_for_review', 'list_driver_review_log', 'review_driver_application', 'review_driver_vehicle', 'list_dispatchable_drivers']
    for (const name of opsTools) expect(tool(name), name).toMatchObject({ auth: { required: true, app_roles: ['ops'] } })
    expect(tool('get_driver_application_detail')).toMatchObject({ auth: { required: true, app_roles: ['ops_pii'] } })
    for (const name of ['save_driver_application', 'submit_driver_application', 'save_driver_vehicle', 'set_driver_availability', 'get_my_driver_application'])
      expect((tool(name) as unknown as { auth?: unknown }).auth, name).toBeUndefined()
  })

  it('captures profile, licence and eligibility; submit needs everything', () => {
    as('drv', 'submit_driver_application') // nothing yet
    expect(appStatus()).toBeUndefined()
    as('drv', 'save_driver_application', { ...application, licence_number: undefined })
    as('drv', 'save_driver_vehicle', vehicle)
    as('drv', 'submit_driver_application')
    expect(appStatus()).toBe('draft') // licence number missing
    as('drv', 'save_driver_application', { ...application, eligibility_confirmed: 0 })
    as('drv', 'submit_driver_application')
    expect(appStatus()).toBe('draft') // eligibility not confirmed
    as('drv', 'save_driver_application', application)
    as('drv', 'submit_driver_application')
    expect(appStatus()).toBe('submitted')
    expect(as('drv', 'get_my_driver_application')).toMatchObject([{ status: 'submitted', licence_number: 'D1234567' }])
  })

  it('submit needs at least one vehicle', () => {
    as('drv', 'save_driver_application', application)
    as('drv', 'submit_driver_application')
    expect(appStatus()).toBe('draft')
  })

  it('locks the application once submitted', () => {
    submitted()
    as('drv', 'save_driver_application', { ...application, full_name: 'Changed' })
    expect(db.prepare('SELECT full_name FROM driver_applications').get()).toEqual({ full_name: 'Dana Driver' })
  })

  it('keeps one driver\'s data invisible to another applicant', () => {
    submitted()
    expect(as('other', 'get_my_driver_application')).toEqual([])
    expect(as('other', 'list_my_driver_vehicles')).toEqual([])
    expect(as('other', 'list_my_driver_review_log')).toEqual([])
  })

  it('the ops list redacts personal details; the full record needs a logged reason first', () => {
    submitted()
    const [row] = as('ops-1', 'list_driver_applications', { status: 'submitted' }) as Record<string, unknown>[]
    expect(row).toMatchObject({ user_id: 'drv', initial: 'D.', phone_masked: '***00', licence_last4: '4567', vehicle_count: 1 })
    expect(JSON.stringify(row)).not.toMatch(/D1234567|Dana Driver|555-0100/)
    expect(as('pii-1', 'get_driver_application_detail', { driver_user_id: 'drv' })).toEqual([]) // no logged reason, nothing
    as('pii-1', 'ops_log_access', { scope: 'driver_pii', driver_user_id: 'drv', reason_code: 'support_ticket' })
    expect(as('pii-1', 'get_driver_application_detail', { driver_user_id: 'drv' })).toMatchObject([{ licence_number: 'D1234567', full_name: 'Dana Driver', phone: '555-0100' }])
    expect(as('pii-2', 'get_driver_application_detail', { driver_user_id: 'drv' })).toEqual([]) // someone else's reason does not count
    expect(as('pii-1', 'get_driver_application_detail', { driver_user_id: 'drv' }, NOW + 10 * 60_000 + 1)).toEqual([]) // expires after 10 minutes
    expect(as('ops-1', 'list_driver_applications', { status: 'approved' })).toEqual([])
  })

  it('approval audits actor and time, and approves the pending vehicle', () => {
    submitted()
    review('approved', undefined, 'ops-1', NOW + 5)
    expect(appStatus()).toBe('approved')
    expect(vehicleStatus()).toBe('approved')
    expect(db.prepare('SELECT user_id, from_status, to_status, reason, actor_id, actor_role, at FROM driver_review_log ORDER BY at, rowid').all()).toEqual([
      { user_id: 'drv', from_status: 'draft', to_status: 'submitted', reason: null, actor_id: 'drv', actor_role: 'applicant', at: NOW },
      { user_id: 'drv', from_status: 'submitted', to_status: 'approved', reason: null, actor_id: 'ops-1', actor_role: 'ops', at: NOW + 5 },
    ])
  })

  it('rejection needs a reason, records it, and lets the driver fix and resubmit', () => {
    submitted()
    review('rejected')
    review('rejected', '   ')
    expect(appStatus()).toBe('submitted') // no reason, no decision, no audit row
    expect(count(db, 'driver_review_log')).toBe(1)
    review('rejected', 'Licence photo unreadable')
    expect(as('drv', 'get_my_driver_application')).toMatchObject([{ status: 'rejected', status_reason: 'Licence photo unreadable' }])
    as('drv', 'save_driver_application', { ...application, licence_number: 'D7654321' })
    as('drv', 'submit_driver_application')
    expect(appStatus()).toBe('submitted')
    expect(as('drv', 'get_my_driver_application')).toMatchObject([{ status_reason: null, licence_number: 'D7654321' }])
    expect((as('drv', 'list_my_driver_review_log') as { to_status: string }[]).map((l) => l.to_status)).toEqual(['submitted', 'rejected', 'submitted'])
  })

  it('only allows valid decision transitions', () => {
    as('drv', 'save_driver_application', application)
    review('approved') // still a draft
    expect(appStatus()).toBe('draft')
    submitted()
    suspend('too early') // a submitted application cannot be suspended
    review('suspended', 'too early') // and the review action no longer suspends at all
    expect(appStatus()).toBe('submitted')
    review('approved')
    review('rejected', 'late') // approved cannot be rejected
    expect(appStatus()).toBe('approved')
    review('banana', 'x')
    expect(appStatus()).toBe('approved')
    review('suspended', 'complaint') // not a review decision any more
    expect(appStatus()).toBe('approved')
    suspend('complaint')
    expect(appStatus()).toBe('suspended')
    review('approved') // the review action cannot reinstate either
    expect(appStatus()).toBe('suspended')
    reinstate()
    expect(appStatus()).toBe('approved')
  })

  it('an ops user cannot review their own application', () => {
    as('ops-1', 'save_driver_application', application)
    as('ops-1', 'save_driver_vehicle', vehicle)
    as('ops-1', 'submit_driver_application')
    as('ops-1', 'review_driver_application', { driver_user_id: 'ops-1', decision: 'approved' })
    expect(appStatus('ops-1')).toBe('submitted')
    expect(as('ops-1', 'list_driver_applications')).toEqual([])
  })

  it('only approved drivers with an approved vehicle can be available', () => {
    goAvailable() // no application at all
    expect(as('drv', 'get_my_driver_availability')).toEqual([])
    submitted()
    goAvailable() // submitted only
    expect(as('drv', 'get_my_driver_availability')).toEqual([])
    review('approved')
    goAvailable()
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 1, vehicle_id: 'v1' }])
    expect(dispatchable()).toMatchObject([{ user_id: 'drv', plate: 'RS-482', vehicle_class: 'comfort' }])
  })

  it('cannot go available with someone else\'s or an unapproved vehicle', () => {
    approved()
    as('drv', 'save_driver_vehicle', { ...vehicle, vehicle_id: 'v2', plate: 'NEW-1' }) // pending
    as('drv', 'set_driver_availability', { available: 1, vehicle_id: 'v2' })
    expect(as('drv', 'get_my_driver_availability')).toEqual([])
    as('drv', 'set_driver_availability', { available: 1, vehicle_id: 'missing' })
    expect(as('drv', 'get_my_driver_availability')).toEqual([])
  })

  it('suspension and rejection take a driver off dispatch immediately', () => {
    approved()
    goAvailable()
    expect(dispatchable()).toHaveLength(1)
    suspend('safety report', 'ops-1', 'safety')
    expect(dispatchable()).toEqual([])
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 0 }])
    goAvailable() // suspended drivers cannot return themselves
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 0 }])
    reinstate() // reinstated, but must opt in again
    expect(dispatchable()).toEqual([])
    goAvailable()
    expect(dispatchable()).toHaveLength(1)
  })

  it('a stale available flag does not make a suspended driver dispatchable', () => {
    approved()
    goAvailable()
    db.prepare("UPDATE driver_applications SET status = 'suspended'").run() // simulate an out-of-band change
    expect(dispatchable()).toEqual([])
  })

  it('an expired licence blocks availability and drops the driver from dispatch', () => {
    approved()
    goAvailable()
    expect(dispatchable()).toHaveLength(1)
    const later = Date.UTC(2031, 0, 1)
    expect(as('ops-1', 'list_dispatchable_drivers', {}, later)).toEqual([])
    as('drv', 'set_driver_availability', { available: 0 }, later)
    goAvailable(later)
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 0 }])
  })

  it('editing an approved vehicle sends it back to review and off dispatch; unchanged saves do not', () => {
    approved()
    goAvailable()
    as('drv', 'save_driver_vehicle', vehicle)
    expect(vehicleStatus()).toBe('approved')
    expect(dispatchable()).toHaveLength(1)
    as('drv', 'save_driver_vehicle', { ...vehicle, plate: 'NEW-9' })
    expect(vehicleStatus()).toBe('pending')
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 0 }])
    expect(dispatchable()).toEqual([])
    as('ops-1', 'review_driver_vehicle', { driver_user_id: 'drv', vehicle_id: 'v1', decision: 'approved' })
    expect(vehicleStatus()).toBe('approved')
  })

  it('vehicle rejection needs a reason, is audited, and removes the vehicle from dispatch', () => {
    approved()
    goAvailable()
    const rv = (decision: string, reason?: string) => as('ops-1', 'review_driver_vehicle', { driver_user_id: 'drv', vehicle_id: 'v1', decision, reason })
    rv('rejected')
    expect(vehicleStatus()).toBe('approved')
    rv('rejected', 'Plate does not match registration')
    expect(vehicleStatus()).toBe('rejected')
    expect(dispatchable()).toEqual([])
    expect(as('drv', 'list_my_driver_vehicles')).toMatchObject([{ status: 'rejected', status_reason: 'Plate does not match registration' }])
    expect(db.prepare("SELECT to_status, actor_role, vehicle_id FROM driver_review_log WHERE vehicle_id = 'v1'").all()).toEqual([
      { to_status: 'rejected', actor_role: 'ops', vehicle_id: 'v1' },
    ])
  })

  it('deleting the active vehicle takes the driver off dispatch', () => {
    approved()
    goAvailable()
    as('drv', 'delete_driver_vehicle', { vehicle_id: 'v1' })
    expect(count(db, 'driver_vehicles')).toBe(0)
    expect(dispatchable()).toEqual([])
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 0 }])
  })

  it('vehicles are per driver even when ids collide', () => {
    as('drv', 'save_driver_vehicle', vehicle)
    as('other', 'save_driver_vehicle', { ...vehicle, plate: 'OTHER' })
    as('other', 'delete_driver_vehicle', { vehicle_id: 'v1' })
    expect(as('drv', 'list_my_driver_vehicles')).toMatchObject([{ plate: 'RS-482' }])
  })
})

describe('driver availability and dispatch matching', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }
  // ~0.009 degrees of latitude is about 1 km.
  const near = (km: number) => ({ lat: SYDNEY.lat + km * 0.009, lng: SYDNEY.lng })

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)

  const makeDriver = (
    id: string,
    opts: { at?: { lat: number; lng: number }; radius?: number; vehicleClass?: string; online?: boolean; locationAt?: number } = {},
  ) => {
    as(id, 'save_driver_application', { full_name: `Driver ${id}`, phone: '1', licence_number: `L-${id}`, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: `P-${id}`, make: 'T', model: 'C', vehicle_class: opts.vehicleClass ?? 'share' })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
    as(id, 'update_driver_location', { ...(opts.at ?? SYDNEY), service_radius_km: opts.radius ?? 10 }, opts.locationAt ?? NOW)
    if (opts.online !== false) as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })
  }

  const ride = (id: string, extra: Partial<RecurringRide> = {}): RecurringRide => ({
    id,
    pickup: 'Central',
    pickupCoord: SYDNEY,
    dropoff: 'Airport',
    dropoffCoord: null,
    days: [],
    time: '09:00',
    driverName: '',
    paused: false,
    createdAt: 1,
    bookingType: 'now',
    vehicle: 'share',
    fareCents: 1500,
    ...extra,
  })
  const request = (rider: string, id = 'r1', extra: Partial<RecurringRide> = {}, now = NOW) => {
    as(rider, 'save_ride', { ...rideToRecords(ride(id, extra)) }, now)
    as(rider, 'request_dispatch', { request_id: id }, now)
  }
  const tick = (rider: string, id = 'r1', now = NOW) => as(rider, 'dispatch_tick', { request_id: id }, now)
  const status = (rider: string, id = 'r1') => as(rider, 'get_dispatch_status', { request_id: id })[0] as Record<string, unknown> | undefined
  const offers = (driver: string, now = NOW) => as(driver, 'list_my_offers', {}, now) as Record<string, unknown>[]
  const offeredTo = (id = 'r1') => (db.prepare("SELECT driver_id FROM dispatch_offers WHERE request_id = ? AND status = 'offered'").get(id) as { driver_id: string } | undefined)?.driver_id
  const offerStatuses = (id = 'r1') => (db.prepare('SELECT driver_id, status FROM dispatch_offers WHERE request_id = ? ORDER BY attempt').all(id) as { driver_id: string; status: string }[])
  const accept = (driver: string, rider = 'rider-1', id = 'r1', now = NOW) => as(driver, 'accept_offer', { rider_id: rider, request_id: id }, now)

  it('only dispatches open on-demand requests with pickup coordinates', () => {
    as('rider-1', 'save_ride', { ...rideToRecords(ride('later', { bookingType: 'scheduled' })) })
    as('rider-1', 'request_dispatch', { request_id: 'later' })
    as('rider-1', 'save_ride', { ...rideToRecords(ride('nocoord', { pickupCoord: null })) })
    as('rider-1', 'request_dispatch', { request_id: 'nocoord' })
    as('rider-1', 'request_dispatch', { request_id: 'missing' })
    expect(count(db, 'dispatch_requests')).toBe(0)
    request('rider-1')
    expect(status('rider-1')).toMatchObject({ status: 'searching', attempts: 0 })
    expect(status('rider-2')).toBeUndefined() // other riders can't see it
  })

  it('offers the nearest eligible driver, breaking ties by driver id', () => {
    makeDriver('far', { at: near(5) })
    makeDriver('close', { at: near(1) })
    request('rider-1')
    tick('rider-1')
    expect(offeredTo()).toBe('close')
    expect(status('rider-1')).toMatchObject({ attempts: 1, offer_status: 'offered', driver_name: null, plate: null })

    makeDriver('b-twin', { at: near(2) })
    makeDriver('a-twin', { at: near(2) })
    request('rider-2', 'r2')
    tick('rider-2', 'r2')
    expect(offeredTo('r2')).toBe('a-twin') // 'close' is locked, twins tie on distance
  })

  it('ignores drivers who are offline, out of radius, too far, or have a stale location', () => {
    makeDriver('offline', { at: near(0.5), online: false })
    makeDriver('narrow', { at: near(3), radius: 1 })
    makeDriver('distant', { at: near(20), radius: 50 })
    makeDriver('stale', { at: near(0.5), locationAt: NOW - 301_000 })
    request('rider-1')
    tick('rider-1')
    expect(offeredTo()).toBeUndefined()
    makeDriver('ok', { at: near(3), radius: 5 })
    tick('rider-1')
    expect(offeredTo()).toBe('ok')
  })

  it('matches vehicle tier: a bigger vehicle can serve a smaller tier, never the reverse', () => {
    makeDriver('share-car', { at: near(0.5), vehicleClass: 'share' })
    request('rider-1', 'r1', { vehicle: 'comfort' })
    tick('rider-1')
    expect(offeredTo()).toBeUndefined()
    makeDriver('xl-van', { at: near(4), vehicleClass: 'xl' })
    tick('rider-1')
    expect(offeredTo()).toBe('xl-van')
    request('rider-2', 'r2', { vehicle: 'share' })
    makeDriver('xl-near', { at: near(0.1), vehicleClass: 'xl' })
    tick('rider-2', 'r2')
    expect(offeredTo('r2')).toBe('xl-near') // nearest eligible wins regardless of tier headroom
  })

  it('never offers to unapproved or suspended drivers', () => {
    makeDriver('susp')
    as('ops', 'ops_suspend_driver', { driver_user_id: 'susp', reason_code: 'complaint', note: 'complaint' })
    as('applicant', 'save_driver_application', { full_name: 'X', eligibility_confirmed: 1 })
    request('rider-1')
    tick('rider-1')
    expect(offeredTo()).toBeUndefined()
  })

  it('never matches a driver to their own ride', () => {
    makeDriver('both')
    request('both')
    tick('both')
    expect(offeredTo()).toBeUndefined()
  })

  it('locks a driver to one live offer: a second rider gets nobody, and the index backs it up', () => {
    makeDriver('solo')
    request('rider-1')
    request('rider-2', 'r2')
    tick('rider-1')
    tick('rider-2', 'r2')
    expect(offeredTo('r1')).toBe('solo')
    expect(offeredTo('r2')).toBeUndefined()
    expect(offers('solo')).toHaveLength(1)

    const insert = (rider: string, req: string, attempt: number) =>
      db.prepare("INSERT INTO dispatch_offers (rider_id, request_id, attempt, driver_id, status, offered_at, expires_at) VALUES (?, ?, ?, ?, 'offered', 1, 2)").run(rider, req, attempt, 'solo')
    expect(() => insert('rider-2', 'r2', 1)).toThrow(/UNIQUE/) // same driver, second live offer
    makeDriver('other')
    expect(() =>
      db.prepare("INSERT INTO dispatch_offers (rider_id, request_id, attempt, driver_id, status, offered_at, expires_at) VALUES ('rider-1', 'r1', 2, 'other', 'offered', 1, 2)").run(),
    ).toThrow(/UNIQUE/) // same request, second live offer
  })

  it('repeated ticks do not stack offers', () => {
    makeDriver('a')
    makeDriver('b', { at: near(1) })
    request('rider-1')
    for (let i = 0; i < 4; i++) tick('rider-1')
    expect(offerStatuses()).toHaveLength(1)
  })

  it('accept atomically assigns driver and rider, creates the trip, and links the driver', () => {
    makeDriver('d1')
    request('rider-1')
    tick('rider-1')
    expect(offers('d1')).toMatchObject([{ rider_id: 'rider-1', request_id: 'r1', status: 'offered', pickup_label: 'Central', dropoff_label: 'Airport', fare_cents: 1500 }])
    accept('d1')

    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'matched' })
    expect(db.prepare('SELECT status, driver_id, vehicle_id FROM assignments').get()).toEqual({ status: 'accepted', driver_id: 'drv_u_d1', vehicle_id: 'veh_v-d1' })
    expect(db.prepare('SELECT display_name, user_id FROM drivers').get()).toEqual({ display_name: 'Driver d1', user_id: 'd1' })
    expect(db.prepare('SELECT plate FROM vehicles').get()).toEqual({ plate: 'P-d1' })
    expect(db.prepare('SELECT id, status, assignment_id FROM trips').get()).toEqual({ id: 'r1:trip', status: 'scheduled', assignment_id: 'r1:assignment' })
    expect(db.prepare('SELECT to_status, actor_type, actor_id FROM trip_transitions').all()).toEqual([{ to_status: 'scheduled', actor_type: 'driver', actor_id: 'd1' }])
    expect(status('rider-1')).toMatchObject({ status: 'matched', offer_status: 'accepted', driver_name: 'Driver d1', plate: 'P-d1' })

    accept('d1') // replay changes nothing
    expect(count(db, 'trips')).toBe(1)
    expect(count(db, 'trip_transitions')).toBe(1)

    // The link makes the trip drivable through the existing driver actions.
    as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'r1:trip', to_status: 'en_route' })
    expect(db.prepare('SELECT status FROM trips').get()).toEqual({ status: 'en_route' })
  })

  it('save_ride replays from the rider device do not undo a match', () => {
    makeDriver('d1')
    request('rider-1')
    tick('rider-1')
    accept('d1')
    as('rider-1', 'save_ride', { ...rideToRecords(ride('r1')) }, NOW + 1)
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'matched' })
  })

  it('the driver stays locked while the trip is active and is released when it finishes', () => {
    makeDriver('d1')
    request('rider-1')
    request('rider-2', 'r2')
    tick('rider-1')
    accept('d1')
    tick('rider-2', 'r2')
    expect(offeredTo('r2')).toBeUndefined() // busy with an accepted assignment
    for (const to of ['en_route', 'arrived']) as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'r1:trip', to_status: to })
    tick('rider-2', 'r2')
    expect(offeredTo('r2')).toBeUndefined()
    as('d1', 'start_trip', { rider_id: 'rider-1', trip_id: 'r1:trip' })
    as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'r1:trip', to_status: 'completed' })
    expect(offerStatuses().map((o) => o.status)).toEqual(['completed'])
    tick('rider-2', 'r2')
    expect(offeredTo('r2')).toBe('d1')
  })

  it('only the offered driver can accept, and not after the offer expires', () => {
    makeDriver('d1')
    makeDriver('d2', { at: near(3) })
    request('rider-1')
    tick('rider-1')
    accept('d2') // not their offer
    expect(offerStatuses()).toEqual([{ driver_id: 'd1', status: 'offered' }])
    accept('d1', 'someone-else') // wrong rider scope
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'open' })
    accept('d1', 'rider-1', 'r1', NOW + 30_000) // exactly at expiry
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'open' })
    expect(count(db, 'trips')).toBe(0)
    expect(offers('d1', NOW + 30_000)).toEqual([]) // expired offers are hidden from the driver
  })

  it('cannot accept once the driver went offline or was suspended', () => {
    makeDriver('d1')
    request('rider-1')
    tick('rider-1')
    as('d1', 'set_driver_availability', { available: 0 })
    expect(offerStatuses()).toEqual([{ driver_id: 'd1', status: 'cancelled' }])
    accept('d1')
    expect(count(db, 'assignments')).toBe(0)

    makeDriver('d2', { at: near(1) })
    tick('rider-1')
    expect(offeredTo()).toBe('d2')
    as('ops', 'ops_suspend_driver', { driver_user_id: 'd2', reason_code: 'safety', note: 'safety' })
    accept('d2')
    expect(count(db, 'assignments')).toBe(0)
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'open' })
  })

  it('decline re-dispatches to the next driver and never re-offers to the decliner', () => {
    makeDriver('d1', { at: near(1) })
    makeDriver('d2', { at: near(2) })
    request('rider-1')
    tick('rider-1')
    as('d1', 'decline_offer', { rider_id: 'rider-1', request_id: 'r1' })
    expect(offers('d1')).toEqual([])
    tick('rider-1')
    expect(offerStatuses()).toEqual([{ driver_id: 'd1', status: 'declined' }, { driver_id: 'd2', status: 'offered' }])
    tick('rider-1')
    expect(offerStatuses()).toHaveLength(2)
  })

  it('timeout expires the offer, frees the driver and re-dispatches', () => {
    makeDriver('d1', { at: near(1) })
    makeDriver('d2', { at: near(2) })
    request('rider-1')
    tick('rider-1')
    tick('rider-1', 'r1', NOW + 29_999)
    expect(offeredTo()).toBe('d1') // not yet expired
    tick('rider-1', 'r1', NOW + 30_000)
    expect(offerStatuses()).toEqual([{ driver_id: 'd1', status: 'expired' }, { driver_id: 'd2', status: 'offered' }])
    accept('d1', 'rider-1', 'r1', NOW + 30_001)
    expect(count(db, 'assignments')).toBe(0)
  })

  it("another rider's dispatch frees a silent driver whose offer expired", () => {
    makeDriver('d1')
    request('rider-1')
    tick('rider-1')
    const later = NOW + 40_000
    request('rider-2', 'r2', {}, later)
    as('rider-2', 'dispatch_tick', { request_id: 'r2' }, later)
    expect(offerStatuses('r1')).toEqual([{ driver_id: 'd1', status: 'expired' }])
    expect(offeredTo('r2')).toBe('d1')
  })

  it('gives up with no_driver after three offers, and the rider can restart', () => {
    for (const [id, km] of [['d1', 1], ['d2', 2], ['d3', 3], ['d4', 4]] as const) makeDriver(id, { at: near(km) })
    request('rider-1')
    for (const id of ['d1', 'd2', 'd3']) {
      tick('rider-1')
      as(id, 'decline_offer', { rider_id: 'rider-1', request_id: 'r1' })
    }
    tick('rider-1')
    expect(status('rider-1')).toMatchObject({ status: 'no_driver', attempts: 3 })
    expect(offeredTo()).toBeUndefined() // d4 was never offered: the cap is 3
    as('rider-1', 'request_dispatch', { request_id: 'r1' }, NOW + 1)
    expect(status('rider-1')).toMatchObject({ status: 'searching', attempts: 0 })
    tick('rider-1', 'r1', NOW + 1)
    expect(offeredTo()).toBe('d1') // a new round may retry earlier decliners
  })

  it('reports no_driver when nobody is available inside the search window', () => {
    request('rider-1')
    tick('rider-1')
    expect(status('rider-1')).toMatchObject({ status: 'searching' })
    tick('rider-1', 'r1', NOW + 120_000)
    expect(status('rider-1')).toMatchObject({ status: 'searching' }) // deadline inclusive
    tick('rider-1', 'r1', NOW + 120_001)
    expect(status('rider-1')).toMatchObject({ status: 'no_driver' })
    makeDriver('late')
    as('rider-1', 'request_dispatch', { request_id: 'r1' }, NOW + 121_000)
    tick('rider-1', 'r1', NOW + 121_000)
    expect(offeredTo()).toBe('late')
  })

  it('a driver arriving mid-search is picked up on the next tick', () => {
    request('rider-1')
    tick('rider-1')
    makeDriver('late')
    tick('rider-1', 'r1', NOW + 5_000)
    expect(offeredTo()).toBe('late')
  })

  it('cancelling the ride withdraws the offer, frees the driver and blocks acceptance', () => {
    makeDriver('d1')
    request('rider-1')
    tick('rider-1')
    as('rider-1', 'cancel_ride', { request_id: 'r1' })
    expect(offerStatuses()).toEqual([{ driver_id: 'd1', status: 'cancelled' }])
    expect(status('rider-1')).toMatchObject({ status: 'cancelled' })
    accept('d1')
    expect(count(db, 'assignments')).toBe(0)
    request('rider-2', 'r2')
    tick('rider-2', 'r2')
    expect(offeredTo('r2')).toBe('d1')
  })

  it('cancelling a matched ride releases the driver', () => {
    makeDriver('d1')
    request('rider-1')
    tick('rider-1')
    accept('d1')
    as('rider-1', 'cancel_ride', { request_id: 'r1' })
    expect(offerStatuses()).toEqual([{ driver_id: 'd1', status: 'cancelled' }])
    expect(db.prepare('SELECT status FROM trips').get()).toEqual({ status: 'cancelled' })
  })

  it('a driver cancelling after accepting releases their lock', () => {
    makeDriver('d1')
    request('rider-1')
    tick('rider-1')
    accept('d1')
    as('d1', 'driver_cancel_trip', { rider_id: 'rider-1', trip_id: 'r1:trip', reason_code: 'vehicle_issue', note: 'flat tyre' })
    expect(offerStatuses()).toEqual([{ driver_id: 'd1', status: 'cancelled' }])
  })

  it('location publishing is restricted to approved drivers and valid values', () => {
    as('nobody', 'update_driver_location', { ...SYDNEY, service_radius_km: 5 })
    makeDriver('d1')
    as('d1', 'update_driver_location', { lat: 95, lng: 0, service_radius_km: 5 })
    as('d1', 'update_driver_location', { ...SYDNEY, service_radius_km: 500 })
    as('d1', 'update_driver_location', { ...SYDNEY, service_radius_km: 0.1 })
    expect(as('nobody', 'get_my_driver_location')).toEqual([])
    expect(as('d1', 'get_my_driver_location')).toMatchObject([{ lat: SYDNEY.lat, service_radius_km: 10 }])
    as('d1', 'update_driver_location', { lat: -33.9, lng: 151.2, service_radius_km: 7 }, NOW + 9)
    expect(as('d1', 'get_my_driver_location')).toMatchObject([{ lat: -33.9, service_radius_km: 7, updated_at: NOW + 9 }])
  })

  it('driver queries never reveal other drivers\' offers', () => {
    makeDriver('d1')
    makeDriver('d2', { at: near(5) })
    request('rider-1')
    tick('rider-1')
    expect(offers('d2')).toEqual([])
    expect(offers('rider-1')).toEqual([])
  })
})

describe('on-demand quotes and request handoff', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const PICKUP = { lat: -33.8688, lng: 151.2093 }
  const DROPOFF = { lat: -33.8688 + 0.045, lng: 151.2093 } // ~5 km north
  const near = (km: number) => ({ lat: PICKUP.lat + km * 0.009, lng: PICKUP.lng })

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)

  const makeDriver = (id: string, vehicleClass = 'share', at = PICKUP) => {
    as(id, 'save_driver_application', { full_name: id, phone: '1', licence_number: id, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: id, make: 'T', model: 'C', vehicle_class: vehicleClass })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
    as(id, 'update_driver_location', { ...at, service_radius_km: 10 })
    as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })
  }

  const route = { pickup_label: 'Central', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dropoff_label: 'North', dropoff_lat: DROPOFF.lat, dropoff_lng: DROPOFF.lng, distance_m: 5000, duration_s: 600 }
  const quote = (id: string, vehicle_class = 'share', extra: Record<string, unknown> = {}, rider = 'rider-1', now = NOW) =>
    as(rider, 'create_quote', { quote_id: id, vehicle_class, ...route, ...extra }, now)
  const row = (id: string) => db.prepare('SELECT * FROM fare_quotes WHERE id = ?').get(id) as Record<string, number | string | null> | undefined
  const accept = (id: string, extra: Record<string, unknown> = {}, rider = 'rider-1', now = NOW) =>
    as(rider, 'accept_quote', { quote_id: id, ride_id: `ride-${id}`, client_record: '{"id":"ride"}', pickup_lat: route.pickup_lat, pickup_lng: route.pickup_lng, dropoff_lat: route.dropoff_lat, dropoff_lng: route.dropoff_lng, distance_m: route.distance_m, ...extra }, now)

  it('captures the route and prices every component on the server', () => {
    quote('qs', 'share')
    quote('qc', 'comfort')
    quote('qx', 'xl')
    expect(row('qs')).toMatchObject({ pickup_label: 'Central', distance_m: 5000, duration_s: 600, base_cents: 200, distance_cents: 550, time_cents: 250, booking_fee_cents: 150, min_adjust_cents: 0, surge_milli: 1000, total_cents: 1150, status: 'pending', created_at: NOW, expires_at: NOW + 300_000 })
    expect(row('qc')).toMatchObject({ distance_cents: 800, time_cents: 380, total_cents: 1530 })
    expect(row('qx')).toMatchObject({ distance_cents: 1100, time_cents: 500, total_cents: 1950 })
    expect((as('rider-1', 'list_pending_quotes') as { id: string }[]).map((r) => r.id)).toEqual(['qs', 'qc', 'qx'])
  })

  it('applies a minimum fare and shows the adjustment', () => {
    quote('short', 'share', { distance_m: 200, duration_s: 60, dropoff_lat: PICKUP.lat + 0.0018, dropoff_lng: PICKUP.lng })
    expect(row('short')).toMatchObject({ base_cents: 200, distance_cents: 22, time_cents: 25, booking_fee_cents: 150, min_adjust_cents: 103, total_cents: 500 })
  })

  it('reports eligible drivers per tier: bigger vehicles serve smaller tiers, never the reverse', () => {
    quote('none')
    expect(row('none')?.nearby_drivers).toBe(0)
    makeDriver('s', 'share', near(1))
    makeDriver('x', 'xl', near(2))
    quote('qs'); quote('qc', 'comfort'); quote('qx', 'xl')
    expect([row('qs')?.nearby_drivers, row('qc')?.nearby_drivers, row('qx')?.nearby_drivers]).toEqual([2, 1, 1])
  })

  it('ignores busy, offline, out-of-range and own-account drivers when counting eligibility', () => {
    makeDriver('far', 'share', near(30))
    makeDriver('off'); as('off', 'set_driver_availability', { available: 0 })
    makeDriver('mine'); // the rider is also a driver: never matched to themselves
    makeDriver('busy', 'share', near(1))
    as('rider-2', 'save_ride', { ...rideToRecords({ id: 'x', pickup: 'A', pickupCoord: PICKUP, dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share' }) })
    db.prepare("INSERT INTO dispatch_offers (rider_id, request_id, attempt, driver_id, status, offered_at, expires_at) VALUES ('rider-2', 'x', 1, 'busy', 'offered', 1, 2)").run()
    makeDriver('ok', 'share', near(2)) // positive control: the only countable driver
    quote('q', 'share', {}, 'mine')
    expect(row('q')?.nearby_drivers).toBe(1) // far, off and busy excluded; 'mine' is the caller
  })

  it('prices demand surge from waiting riders vs. nearby drivers, excluding the rider\'s own search', () => {
    makeDriver('d1')
    for (const [i, rider] of ['w1', 'w2', 'w3'].entries()) {
      as(rider, 'save_ride', { ...rideToRecords({ id: `w${i}`, pickup: 'A', pickupCoord: near(0.5), dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share' }) })
      as(rider, 'request_dispatch', { request_id: `w${i}` })
    }
    quote('surged')
    expect(row('surged')).toMatchObject({ surge_milli: 1500, total_cents: 1725 }) // (3 waiting - 1 driver) * 0.25x
    expect(row('surged')?.total_cents).toBe(Math.round((1150 * 1500) / 1000))
    quote('own', 'share', {}, 'w1')
    expect(row('own')?.surge_milli).toBe(1250) // w1's own search is excluded
    for (const r of ['w4', 'w5', 'w6', 'w7', 'w8']) {
      as(r, 'save_ride', { ...rideToRecords({ id: r, pickup: 'A', pickupCoord: near(0.5), dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share' }) })
      as(r, 'request_dispatch', { request_id: r })
    }
    quote('capped')
    expect(row('capped')?.surge_milli).toBe(2000) // capped at 2.0x
  })

  it('rejects malformed or implausible routes', () => {
    quote('under', 'share', { distance_m: 3000 }) // shorter than the 5 km straight line
    quote('badclass', 'limo')
    quote('tiny', 'share', { distance_m: 50 })
    quote('lat', 'share', { pickup_lat: 95 })
    quote('time', 'share', { duration_s: 5 })
    expect(count(db, 'fare_quotes')).toBe(0)
    quote('ok', 'share', { distance_m: 4600 }) // 92% of straight line: allowed (roads can't beat 90%)
    expect(row('ok')).toBeDefined()
  })

  it('a new quote supersedes older ones for that tier and for any other route; other tiers on the same route coexist', () => {
    quote('a-share'); quote('a-comfort', 'comfort')
    quote('b-share') // same route + tier
    expect([row('a-share')?.status, row('b-share')?.status, row('a-comfort')?.status]).toEqual(['superseded', 'pending', 'pending'])
    quote('c-xl', 'xl', { dropoff_lat: DROPOFF.lat + 0.01, distance_m: 6200 }) // route changed
    expect([row('b-share')?.status, row('a-comfort')?.status, row('c-xl')?.status]).toEqual(['superseded', 'superseded', 'pending'])
    expect(as('rider-1', 'list_pending_quotes')).toHaveLength(1)
    expect(as('rider-2', 'list_pending_quotes')).toEqual([]) // never touches other riders' quotes
  })

  it('quotes expire after 5 minutes and cannot be accepted', () => {
    quote('q')
    expect(as('rider-1', 'list_pending_quotes', {}, NOW + 299_999)).toHaveLength(1)
    expect(as('rider-1', 'list_pending_quotes', {}, NOW + 300_000)).toEqual([])
    accept('q', {}, 'rider-1', NOW + 300_000)
    expect(row('q')?.status).toBe('expired')
    expect(count(db, 'ride_requests')).toBe(0)
    expect(count(db, 'dispatch_requests')).toBe(0)
  })

  it('expire_stale_quotes expires only overdue pending quotes', () => {
    quote('old')
    quote('fresh', 'comfort', {}, 'rider-2', NOW + 200_000)
    as('rider-3', 'expire_stale_quotes', {}, NOW + 310_000)
    expect([row('old')?.status, row('fresh')?.status]).toEqual(['expired', 'pending'])
  })

  it('accepting creates the ride, the accepted quote and a searching dispatch request, and dispatch can match it', () => {
    makeDriver('d1', 'share', near(1))
    quote('q')
    accept('q')
    expect(row('q')).toMatchObject({ status: 'accepted', ride_id: 'ride-q', accepted_at: NOW })
    expect(db.prepare('SELECT booking_type, status, pickup_label, vehicle_class, client_record FROM ride_requests').get()).toEqual({ booking_type: 'now', status: 'open', pickup_label: 'Central', vehicle_class: 'share', client_record: '{"id":"ride"}' })
    expect(db.prepare('SELECT fare_cents, status, request_id FROM quotes').get()).toEqual({ fare_cents: 1150, status: 'accepted', request_id: 'ride-q' })
    expect(as('rider-1', 'get_dispatch_status', { request_id: 'ride-q' })).toMatchObject([{ status: 'searching' }])

    as('rider-1', 'dispatch_tick', { request_id: 'ride-q' })
    expect(as('d1', 'list_my_offers')).toMatchObject([{ request_id: 'ride-q', status: 'offered', fare_cents: 1150 }])
    expect(as('rider-1', 'get_quote', { quote_id: 'q' })).toEqual([{ id: 'q', status: 'accepted', ride_id: 'ride-q', total_cents: 1150, expires_at: NOW + 300_000 }])
  })

  it('accept is idempotent and a quote cannot be reused for a second ride', () => {
    makeDriver('d1')
    quote('q')
    accept('q')
    accept('q')
    accept('q', { ride_id: 'another-ride' })
    expect(count(db, 'ride_requests')).toBe(1)
    expect(count(db, 'dispatch_requests')).toBe(1)
    expect(row('q')?.ride_id).toBe('ride-q')
  })

  it('refuses when the route changed materially, and tolerates a small drift', () => {
    makeDriver('d1')
    quote('moved')
    accept('moved', { dropoff_lat: DROPOFF.lat + 0.02 })
    expect(row('moved')?.status).toBe('superseded')
    quote('longer')
    accept('longer', { distance_m: 5600 }) // +12%
    expect(row('longer')?.status).toBe('superseded')
    quote('drift')
    accept('drift', { distance_m: 5400 }) // +8%
    expect(row('drift')?.status).toBe('accepted')
    expect(count(db, 'ride_requests')).toBe(1)
  })

  it('refuses when demand moved: the surge changed, or no driver is eligible any more', () => {
    makeDriver('d1')
    quote('q1')
    for (const [i, rider] of ['w1', 'w2'].entries()) {
      as(rider, 'save_ride', { ...rideToRecords({ id: `w${i}`, pickup: 'A', pickupCoord: near(0.5), dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share' }) })
      as(rider, 'request_dispatch', { request_id: `w${i}` })
    }
    accept('q1')
    expect(row('q1')?.status).toBe('superseded') // surge 1.0 -> 1.25
    expect(count(db, 'ride_requests')).toBe(3 - 1) // only the two waiting riders'

    db.prepare("UPDATE dispatch_requests SET status = 'cancelled'").run()
    quote('q2')
    as('d1', 'set_driver_availability', { available: 0 })
    accept('q2')
    expect(row('q2')?.status).toBe('superseded')
  })

  it('only the owner can accept a quote', () => {
    makeDriver('d1')
    quote('q')
    accept('q', {}, 'rider-2')
    expect(row('q')?.status).toBe('pending')
    expect(as('rider-2', 'get_quote', { quote_id: 'q' })).toEqual([])
    expect(count(db, 'ride_requests')).toBe(0)
  })

  it('does not accept onto a ride id that already exists', () => {
    makeDriver('d1')
    as('rider-1', 'save_ride', { ...rideToRecords({ id: 'taken', pickup: 'A', pickupCoord: PICKUP, dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share' }) })
    quote('q')
    accept('q', { ride_id: 'taken' })
    expect(row('q')?.status).toBe('pending')
  })

  it('save_ride replay of an accepted ride keeps one quote row at the accepted fare', () => {
    makeDriver('d1')
    quote('q')
    accept('q')
    as('rider-1', 'save_ride', { ...rideToRecords({ id: 'ride-q', pickup: 'Central', pickupCoord: PICKUP, dropoff: 'North', dropoffCoord: DROPOFF, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1150 }) }, NOW + 1)
    expect(count(db, 'quotes')).toBe(1)
    expect(count(db, 'ride_requests')).toBe(1)
    expect(db.prepare('SELECT fare_cents FROM quotes').get()).toEqual({ fare_cents: 1150 })
  })
})

describe('authoritative trip lifecycle and permissions', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }
  const MIN = 60_000

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)

  const makeDriver = (id: string) => {
    as(id, 'save_driver_application', { full_name: `Driver ${id}`, phone: '1', licence_number: id, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: id, make: 'T', model: 'C', vehicle_class: 'share' })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
    as(id, 'update_driver_location', { ...SYDNEY, service_radius_km: 10 })
    as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })
  }
  const ride = (id: string, fareCents = 1500): RecurringRide => ({ id, pickup: 'Central', pickupCoord: SYDNEY, dropoff: 'Airport', dropoffCoord: null, days: [], time: '09:00', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents })
  /** Rider requests, driver d1 accepts at `at`. Trip id is `<id>:trip`. */
  const matched = (id = 'r1', rider = 'rider-1', driver = 'd1', at = NOW, fareCents = 1500) => {
    if (!db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(driver)) makeDriver(driver)
    as(rider, 'save_ride', { ...rideToRecords(ride(id, fareCents)) }, at)
    as(rider, 'request_dispatch', { request_id: id }, at)
    as(rider, 'dispatch_tick', { request_id: id }, at)
    as(driver, 'accept_offer', { rider_id: rider, request_id: id }, at)
  }
  const trip = (id = 'r1:trip', rider = 'rider-1') => ({ rider_id: rider, trip_id: id })
  const advance = (to: string, driver = 'd1', now = NOW, id = 'r1:trip', rider = 'rider-1') => as(driver, 'advance_trip', { ...trip(id, rider), to_status: to }, now)
  const start = (driver = 'd1', now = NOW, id = 'r1:trip', rider = 'rider-1') => as(driver, 'start_trip', trip(id, rider), now)
  const status = (id = 'r1:trip') => (db.prepare('SELECT status FROM trips WHERE id = ?').get(id) as { status: string } | undefined)?.status
  const life = (id = 'r1:trip') => db.prepare('SELECT * FROM trip_lifecycle WHERE trip_id = ?').get(id) as Record<string, unknown> | undefined
  const events = (id = 'r1:trip') => db.prepare('SELECT event, actor_role, reason_code, note, amount_cents FROM trip_lifecycle_events WHERE trip_id = ? AND rider_id = ? ORDER BY at, rowid').all(id, 'rider-1')
  const phase = (id = 'r1', rider = 'rider-1') => (as(rider, 'get_my_trip_lifecycle', { request_id: id }) as { phase: string }[])[0]?.phase
  const rows = (table: string) => count(db, table)
  const toArrived = (at = NOW) => { advance('en_route', 'd1', at); advance('arrived', 'd1', at) }

  it('runs request -> assignment -> arrival -> start -> completion with an audit trail', () => {
    matched()
    expect(phase()).toBe('scheduled')
    advance('en_route', 'd1', NOW + 1000)
    expect(phase()).toBe('en_route')
    advance('arrived', 'd1', NOW + 2000)
    expect(phase()).toBe('arrived')
    start('d1', NOW + 3000)
    expect(phase()).toBe('in_progress') // status stays arrived; the lifecycle knows it started
    expect(status()).toBe('arrived')
    advance('completed', 'd1', NOW + 4000)
    expect(phase()).toBe('completed')
    expect(life()).toMatchObject({ started_at: NOW + 3000, started_by: 'd1', ended_at: NOW + 4000, outcome: 'completed', cancel_fee_cents: 0 })
    expect(events()).toEqual([
      { event: 'started', actor_role: 'driver', reason_code: null, note: null, amount_cents: null },
      { event: 'completed', actor_role: 'driver', reason_code: null, note: null, amount_cents: null },
    ])
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'completed' })
    expect(db.prepare('SELECT status FROM dispatch_offers').get()).toEqual({ status: 'completed' })
    expect((as('rider-1', 'get_my_trip_history', { trip_id: 'r1:trip' }) as { to_status: string }[]).map((h) => h.to_status)).toEqual(['scheduled', 'en_route', 'arrived', 'completed'])
  })

  it('rejects out-of-order and repeated transitions without writing audit rows', () => {
    matched()
    const snapshotOf = () => [rows('trip_transitions'), rows('trip_events'), rows('trip_lifecycle_events')]
    start() // not arrived yet
    advance('arrived') // skips en_route
    advance('completed') // skips everything
    expect(status()).toBe('scheduled')
    expect(snapshotOf()).toEqual([1, 1, 0])
    advance('en_route')
    advance('en_route') // repeat
    advance('completed') // not started
    toArrived()
    advance('completed') // arrived but never started
    expect(status()).toBe('arrived')
    start()
    const afterStart = snapshotOf()
    start() // repeat
    advance('en_route') // backwards
    expect(snapshotOf()).toEqual(afterStart)
    advance('completed')
    advance('completed') // repeat
    start() // after the end
    expect(events().map((e) => (e as { event: string }).event)).toEqual(['started', 'completed'])
  })

  it('the lifecycle actions belong to the assigned driver only', () => {
    matched()
    makeDriver('d2')
    advance('en_route', 'd2') // another driver
    advance('en_route', 'rider-1') // the rider
    advance('en_route', 'ops')
    expect(status()).toBe('scheduled')
    toArrived()
    start('d2'); start('rider-1'); start('ops')
    expect(life()?.started_at ?? null).toBeNull()
    for (const who of ['d2', 'rider-1', 'ops']) {
      as(who, 'driver_cancel_trip', { ...trip(), reason_code: 'other' })
      as(who, 'report_rider_no_show', trip(), NOW + 10 * MIN)
    }
    expect(status()).toBe('arrived')
    expect(rows('trip_lifecycle_events')).toBe(0)
    // Another rider's cancel_ride is scoped to their own requests.
    as('rider-2', 'cancel_ride', { request_id: 'r1' })
    as('rider-2', 'report_driver_no_show', { request_id: 'r1' }, NOW + 60 * MIN)
    expect(status()).toBe('arrived')
  })

  it('ops-only actions are declared role-gated, and ops cannot act on trips they take part in', () => {
    for (const name of ['ops_cancel_trip', 'ops_resolve_dispute', 'ops_list_disputes', 'ops_get_trip_timeline'])
      expect(tool(name), name).toMatchObject({ auth: { required: true, app_roles: ['ops'] } })
    for (const name of ['advance_trip', 'start_trip', 'driver_cancel_trip', 'report_rider_no_show', 'report_driver_no_show', 'cancel_ride', 'open_dispute'])
      expect((tool(name) as unknown as { auth?: unknown }).auth, name).toBeUndefined()
    matched('r1', 'ops-rider')
    as('ops-rider', 'ops_cancel_trip', { ...trip('r1:trip', 'ops-rider'), reason_code: 'other', note: 'x' }) // the rider is the ops user
    expect(status()).toBe('scheduled')
    as('d1', 'ops_cancel_trip', { ...trip('r1:trip', 'ops-rider'), reason_code: 'other', note: 'x' }) // the driver is the ops user
    expect(status()).toBe('scheduled')
    expect(as('d1', 'ops_get_trip_timeline', trip('r1:trip', 'ops-rider'))).toEqual([])
    expect(as('ops-rider', 'ops_get_trip_timeline', trip('r1:trip', 'ops-rider'))).toEqual([])
  })

  describe('rider cancellation', () => {
    it('is free and leaves no trip record before a driver is assigned', () => {
      as('rider-1', 'save_ride', { ...rideToRecords(ride('r1')) })
      as('rider-1', 'request_dispatch', { request_id: 'r1' })
      expect(as('rider-1', 'preview_cancellation', { request_id: 'r1' })).toEqual([])
      as('rider-1', 'cancel_ride', { request_id: 'r1', reason_code: 'changed_plans' })
      expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'cancelled' })
      expect(as('rider-1', 'get_dispatch_status', { request_id: 'r1' })).toMatchObject([{ status: 'cancelled' }])
      expect(rows('trip_lifecycle')).toBe(0)
    })

    it('charges by policy: grace, late, and arrived, capped at the fare, with the reason recorded', () => {
      const fee = (at: number, fare: number, arrived: boolean) => {
        db = new DatabaseSync(':memory:')
        migrate(db, new Set())
        matched('r1', 'rider-1', 'd1', NOW, fare)
        if (arrived) toArrived(NOW + 1000)
        const preview = as('rider-1', 'preview_cancellation', { request_id: 'r1' }, at)[0]
        as('rider-1', 'cancel_ride', { request_id: 'r1', reason_code: 'wait_too_long', note: '  too slow  ' }, at)
        return { preview, row: life() }
      }
      expect(fee(NOW + 120_000, 1500, false)).toMatchObject({ preview: { fee_cents: 0, policy: 'free_grace' }, row: { cancel_fee_cents: 0, fee_policy: 'free_grace' } })
      expect(fee(NOW + 120_001, 1500, false)).toMatchObject({ preview: { fee_cents: 500, policy: 'late_cancel' }, row: { cancel_fee_cents: 500, fee_policy: 'late_cancel' } })
      expect(fee(NOW + 120_001, 300, false).row).toMatchObject({ cancel_fee_cents: 300 }) // capped at the fare
      expect(fee(NOW + MIN, 1500, true)).toMatchObject({ preview: { fee_cents: 800, policy: 'arrived_cancel' }, row: { cancel_fee_cents: 800, fee_policy: 'arrived_cancel', outcome: 'rider_cancelled', cancelled_by_role: 'rider', cancel_code: 'wait_too_long', cancel_note: 'too slow' } })
      expect(events()).toEqual([{ event: 'cancelled', actor_role: 'rider', reason_code: 'wait_too_long', note: 'too slow', amount_cents: 800 }])
      expect(status()).toBe('cancelled')
      expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'cancelled' })
      expect(db.prepare('SELECT status FROM dispatch_offers').get()).toEqual({ status: 'cancelled' })
      expect(db.prepare("SELECT metadata FROM trip_transitions WHERE to_status = 'cancelled'").get()).toEqual({ metadata: expect.stringContaining('"fee_policy":"arrived_cancel"') })
    })

    it('normalises unknown reasons to other and caps notes at 200 characters', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1', reason_code: 'because', note: 'x'.repeat(500) })
      expect(life()).toMatchObject({ cancel_code: 'other' })
      expect(String(life()?.cancel_note)).toHaveLength(200)
    })

    it('cancelling twice records one cancellation', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 1)
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 2)
      expect(rows('trip_lifecycle_events')).toBe(1)
      expect(db.prepare("SELECT COUNT(*) AS n FROM trip_transitions WHERE to_status = 'cancelled'").get()).toEqual({ n: 1 })
    })

    it('is refused once the trip has started, and never rewrites a completed trip', () => {
      matched()
      toArrived()
      start()
      as('rider-1', 'cancel_ride', { request_id: 'r1' })
      expect(status()).toBe('arrived')
      expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'matched' })
      expect(db.prepare('SELECT status FROM dispatch_offers').get()).toEqual({ status: 'accepted' })
      advance('completed')
      as('rider-1', 'cancel_ride', { request_id: 'r1' }) // e.g. "delete" from the home list
      expect(status()).toBe('completed')
      expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'completed' })
      expect(life()).toMatchObject({ outcome: 'completed' })
    })
  })

  describe('driver cancellation and no-shows', () => {
    it('driver cancel records a validated reason, charges the rider nothing and frees the driver', () => {
      matched()
      as('d1', 'driver_cancel_trip', { ...trip(), reason_code: 'safety', note: 'unsafe pickup' }, NOW + 5 * MIN)
      expect(life()).toMatchObject({ outcome: 'driver_cancelled', cancelled_by_role: 'driver', cancel_code: 'safety', cancel_note: 'unsafe pickup', cancel_fee_cents: 0, fee_policy: 'driver_cancelled' })
      expect(status()).toBe('cancelled')
      expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'cancelled' })
      as('rider-2', 'save_ride', { ...rideToRecords(ride('r2')) })
      as('rider-2', 'request_dispatch', { request_id: 'r2' })
      as('rider-2', 'dispatch_tick', { request_id: 'r2' })
      expect(as('d1', 'list_my_offers')).toMatchObject([{ request_id: 'r2' }]) // lock released
    })

    it('uses the driver reason list and refuses to cancel a started trip', () => {
      matched()
      as('d1', 'driver_cancel_trip', { ...trip(), reason_code: 'changed_plans' }) // a rider code
      expect(life()).toMatchObject({ cancel_code: 'other' })
      db = new DatabaseSync(':memory:'); migrate(db, new Set())
      matched(); toArrived(); start()
      as('d1', 'driver_cancel_trip', { ...trip(), reason_code: 'safety' })
      expect(status()).toBe('arrived')
    })

    it('the driver can report a rider no-show only after waiting 5 minutes at the pickup', () => {
      matched('r1', 'rider-1', 'd1', NOW, 1500)
      as('d1', 'report_rider_no_show', trip(), NOW + 10 * MIN) // not arrived
      expect(status()).toBe('scheduled')
      toArrived(NOW + MIN)
      as('d1', 'report_rider_no_show', trip(), NOW + MIN + 5 * MIN - 1)
      expect(status()).toBe('arrived')
      as('d1', 'report_rider_no_show', { ...trip(), note: 'called twice' }, NOW + MIN + 5 * MIN)
      expect(status()).toBe('cancelled')
      expect(life()).toMatchObject({ outcome: 'rider_no_show', cancel_fee_cents: 800, fee_policy: 'rider_no_show', cancelled_by_role: 'driver' })
      expect(events()).toEqual([{ event: 'no_show', actor_role: 'driver', reason_code: 'rider_no_show', note: 'called twice', amount_cents: 800 }])
      expect(db.prepare('SELECT status FROM dispatch_offers').get()).toEqual({ status: 'cancelled' })
    })

    it('cannot report a no-show after the trip has started', () => {
      matched(); toArrived(); start()
      as('d1', 'report_rider_no_show', trip(), NOW + 30 * MIN)
      expect(status()).toBe('arrived')
    })

    it('the rider can report a driver no-show only after 15 minutes without arrival', () => {
      matched()
      as('rider-1', 'report_driver_no_show', { request_id: 'r1' }, NOW + 15 * MIN - 1)
      expect(status()).toBe('scheduled')
      as('rider-1', 'report_driver_no_show', { request_id: 'r1', note: 'never came' }, NOW + 15 * MIN)
      expect(status()).toBe('cancelled')
      expect(life()).toMatchObject({ outcome: 'driver_no_show', cancel_fee_cents: 0, fee_policy: 'driver_fault', cancelled_by_role: 'rider' })
      db = new DatabaseSync(':memory:'); migrate(db, new Set())
      matched(); toArrived(NOW + 1000)
      as('rider-1', 'report_driver_no_show', { request_id: 'r1' }, NOW + 60 * MIN) // the driver did arrive
      expect(status()).toBe('arrived')
    })
  })

  describe('operations', () => {
    it('cancels a trip in progress with a mandatory note and a capped fee', () => {
      matched(); toArrived(); start()
      as('ops', 'ops_cancel_trip', { ...trip(), reason_code: 'safety_incident', note: '  ' }, NOW + 1) // blank note
      expect(status()).toBe('arrived')
      as('ops', 'ops_cancel_trip', { ...trip(), reason_code: 'safety_incident', note: 'safety incident', fee_cents: 99_999 }, NOW + 2)
      expect(status()).toBe('cancelled')
      expect(life()).toMatchObject({ outcome: 'ops_cancelled', cancelled_by_role: 'ops', cancel_fee_cents: 1500, fee_policy: 'ops_set' })
      expect(events().at(-1)).toEqual({ event: 'cancelled', actor_role: 'ops', reason_code: 'safety_incident', note: 'safety incident', amount_cents: 1500 })
      expect(db.prepare('SELECT status FROM dispatch_offers').get()).toEqual({ status: 'cancelled' })
    })

    it('does not touch finished trips and never charges a negative fee', () => {
      matched(); toArrived(); start(); advance('completed')
      as('ops', 'ops_cancel_trip', { ...trip(), reason_code: 'other', note: 'late' })
      expect(status()).toBe('completed')
      db = new DatabaseSync(':memory:'); migrate(db, new Set())
      matched()
      as('ops', 'ops_cancel_trip', { ...trip(), reason_code: 'duplicate_request', note: 'dup', fee_cents: -50 })
      expect(life()).toMatchObject({ cancel_fee_cents: 0 })
    })

    it('reads a trip timeline of transitions and lifecycle events in order', () => {
      matched(); toArrived(NOW + 1000); start('d1', NOW + 2000); advance('completed', 'd1', NOW + 3000)
      const timeline = as('ops', 'ops_get_trip_timeline', trip()) as { kind: string; name: string; at: number }[]
      expect(timeline.map((t) => `${t.kind}:${t.name}`)).toEqual(['transition:scheduled', 'transition:en_route', 'transition:arrived', 'event:started', 'transition:completed', 'event:completed'])
    })
  })

  describe('disputes', () => {
    const dispute = (who: string, code: string, now = NOW + 140_000, note = 'n') => as(who, 'open_dispute', { ...trip(), reason_code: code, note }, now)
    const disputes = () => db.prepare('SELECT opened_by, opened_role, reason_code, status FROM trip_disputes ORDER BY opened_by').all()
    const finishTrip = () => { matched(); toArrived(); start('d1', NOW + 1); advance('completed', 'd1', NOW + 2) }

    it('lets the rider and the assigned driver each dispute a finished trip once, with role-specific codes', () => {
      finishTrip()
      dispute('rider-1', 'overcharged')
      dispute('rider-1', 'route') // repeat
      dispute('d1', 'rider_conduct')
      dispute('d1', 'damage')
      expect(disputes()).toEqual([
        { opened_by: 'd1', opened_role: 'driver', reason_code: 'rider_conduct', status: 'open' },
        { opened_by: 'rider-1', opened_role: 'rider', reason_code: 'overcharged', status: 'open' },
      ])
      expect(events().map((e) => (e as { event: string }).event)).toEqual(['started', 'completed', 'dispute_opened', 'dispute_opened'])
      expect(as('rider-1', 'list_my_disputes')).toMatchObject([{ reason_code: 'overcharged', status: 'open' }])
      expect(as('rider-1', 'get_my_trip_lifecycle', { request_id: 'r1' })).toMatchObject([{ disputed: 1 }])
    })

    it('rejects wrong-role codes, strangers, and trips that are still open', () => {
      matched()
      dispute('rider-1', 'overcharged') // still open
        toArrived(); start('d1', NOW + 1); advance('completed', 'd1', NOW + 2)
      dispute('rider-1', 'rider_conduct') // driver-only code
      dispute('d1', 'driver_conduct') // rider-only code
      dispute('d2', 'other')
      dispute('rider-2', 'other')
      dispute('ops', 'other')
      expect(disputes()).toEqual([])
    })

    it('expires 7 days after the trip ended', () => {
      finishTrip()
      dispute('rider-1', 'overcharged', NOW + 7 * 24 * 60 * MIN + 3)
      expect(disputes()).toEqual([])
      dispute('rider-1', 'overcharged', NOW + 7 * 24 * 60 * MIN + 2)
      expect(disputes()).toHaveLength(1)
    })

    it('covers cancelled trips too, and ops resolve with a note, once', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1', reason_code: 'wrong_pickup' }, NOW + 130_000)
      dispute('rider-1', 'cancel_fee')
      const open = () => as('ops', 'ops_list_disputes') as Record<string, unknown>[]
      expect(open()).toMatchObject([{ opened_by: 'rider-1', reason_code: 'cancel_fee', outcome: 'rider_cancelled', cancel_fee_cents: 500 }])
      const resolve = (extra: Record<string, unknown>, who = 'ops') => as(who, 'ops_resolve_dispute', { ...trip(), opened_by: 'rider-1', decision: 'upheld', note: 'ok', waive_fee: 0, ...extra }, NOW + 200_000)
      resolve({ note: '  ' }); resolve({ decision: 'maybe' }); resolve({ opened_by: 'nobody' })
      expect(open()).toHaveLength(1)
      resolve({ waive_fee: 1, note: 'driver was late' })
      expect(open()).toEqual([])
      expect(db.prepare('SELECT status, decision, resolution_note, resolved_by, fee_waived FROM trip_disputes').get()).toEqual({ status: 'resolved', decision: 'upheld', resolution_note: 'driver was late', resolved_by: 'ops', fee_waived: 1 })
      expect(life()).toMatchObject({ cancel_fee_cents: 0, fee_policy: 'ops_waived' })
      expect(events().map((e) => (e as { event: string }).event)).toEqual(['cancelled', 'dispute_opened', 'fee_waived', 'dispute_resolved'])
      resolve({ decision: 'rejected', note: 'second try' }) // already resolved
      expect(db.prepare('SELECT decision FROM trip_disputes').get()).toEqual({ decision: 'upheld' })
      expect(as('rider-1', 'list_my_disputes')).toMatchObject([{ status: 'resolved', decision: 'upheld', resolution_note: 'driver was late', fee_waived: 1 }])
    })

    it('a rejected dispute leaves the fee alone; ops cannot resolve disputes on their own trips', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 130_000)
      dispute('rider-1', 'cancel_fee')
      as('d1', 'ops_resolve_dispute', { ...trip(), opened_by: 'rider-1', decision: 'upheld', note: 'x', waive_fee: 1 }) // the driver is the ops user
      expect(db.prepare('SELECT status FROM trip_disputes').get()).toEqual({ status: 'open' })
      as('ops', 'ops_resolve_dispute', { ...trip(), opened_by: 'rider-1', decision: 'rejected', note: 'policy applied', waive_fee: 1 })
      expect(life()).toMatchObject({ cancel_fee_cents: 500, fee_policy: 'late_cancel' })
      expect(db.prepare('SELECT fee_waived FROM trip_disputes').get()).toEqual({ fee_waived: 0 })
    })
  })

  describe('duplicate requests', () => {
    const quoteAndAccept = (quoteId: string, rideId: string, now = NOW) => {
      as('rider-1', 'create_quote', { quote_id: quoteId, vehicle_class: 'share', pickup_label: 'A', pickup_lat: SYDNEY.lat, pickup_lng: SYDNEY.lng, dropoff_label: 'B', dropoff_lat: SYDNEY.lat + 0.045, dropoff_lng: SYDNEY.lng, distance_m: 5000, duration_s: 600 }, now)
      as('rider-1', 'accept_quote', { quote_id: quoteId, ride_id: rideId, client_record: '{}', pickup_lat: SYDNEY.lat, pickup_lng: SYDNEY.lng, dropoff_lat: SYDNEY.lat + 0.045, dropoff_lng: SYDNEY.lng, distance_m: 5000 }, now)
      return (as('rider-1', 'get_quote', { quote_id: quoteId })[0] as { status: string }).status
    }

    it('refuses a second on-demand request while one is searching, matched or in progress', () => {
      makeDriver('d1')
      expect(quoteAndAccept('q1', 'a')).toBe('accepted')
      expect(quoteAndAccept('q2', 'b')).toBe('pending') // refused; the quote is not consumed
      expect(rows('ride_requests')).toBe(1)
      as('rider-1', 'dispatch_tick', { request_id: 'a' })
      as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'a' })
      makeDriver('d2') // a free driver exists, so only the active-ride rule can be refusing
      expect(quoteAndAccept('q3', 'c')).toBe('pending')
      as('rider-1', 'save_ride', { ...rideToRecords(ride('direct')) })
      as('rider-1', 'request_dispatch', { request_id: 'direct' })
      expect(as('rider-1', 'get_dispatch_status', { request_id: 'direct' })).toEqual([])
    })

    it('allows a new request once the previous trip is finished, cancelled, or its search timed out', () => {
      makeDriver('d1')
      quoteAndAccept('q1', 'a')
      expect(quoteAndAccept('q2', 'b', NOW + 120_001)).toBe('accepted') // 'a' stopped searching long ago
      as('rider-1', 'cancel_ride', { request_id: 'b' }, NOW + 130_000)
      expect(quoteAndAccept('q3', 'c', NOW + 140_000)).toBe('accepted')
    })

    it('allows a new request after a completed trip', () => {
      makeDriver('d1')
      quoteAndAccept('q1', 'a')
      as('rider-1', 'dispatch_tick', { request_id: 'a' })
      as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'a' })
      for (const to of ['en_route', 'arrived']) as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'a:trip', to_status: to })
      as('d1', 'start_trip', { rider_id: 'rider-1', trip_id: 'a:trip' })
      as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'a:trip', to_status: 'completed' })
      expect(quoteAndAccept('q2', 'b')).toBe('accepted')
    })
  })
})

describe('live driver location', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }
  const DAY = 24 * 60 * 60_000

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)
  const makeDriver = (id: string) => {
    as(id, 'save_driver_application', { full_name: id, phone: '1', licence_number: id, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: id, make: 'T', model: 'C', vehicle_class: 'share' })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
    as(id, 'update_driver_location', { ...SYDNEY, service_radius_km: 10 })
    as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })
  }
  const matched = (id = 'r1', rider = 'rider-1', driver = 'd1') => {
    if (!db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(driver)) makeDriver(driver)
    as(rider, 'save_ride', { ...rideToRecords({ id, pickup: 'A', pickupCoord: SYDNEY, dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1500 }) })
    as(rider, 'request_dispatch', { request_id: id })
    as(rider, 'dispatch_tick', { request_id: id })
    as(driver, 'accept_offer', { rider_id: rider, request_id: id })
  }
  const trip = { rider_id: 'rider-1', trip_id: 'r1:trip' }
  const publish = (driver = 'd1', at = NOW, extra: Record<string, unknown> = {}, ids = trip) =>
    as(driver, 'publish_driver_location', { ...ids, lat: -33.86881234, lng: 151.20931234, accuracy_m: 8, speed_mps: 11, ...extra }, at)
  const stored = () => db.prepare('SELECT lat, lng, accuracy_m, speed_mps, updated_at, driver_id FROM trip_locations').all()
  const read = (rider = 'rider-1', at = NOW, id = 'r1') => as(rider, 'get_driver_location', { request_id: id }, at) as Record<string, unknown>[]
  const drive = (to: string, driver = 'd1') => as(driver, 'advance_trip', { ...trip, to_status: to })

  it('accepts updates only from the assigned driver, only after they start driving', () => {
    matched()
    publish() // scheduled: the driver has not started driving
    expect(stored()).toEqual([])
    drive('en_route')
    makeDriver('d2')
    publish('d2'); publish('rider-1'); publish('ops') // another driver, the rider, ops
    expect(stored()).toEqual([])
    publish('d1')
    expect(stored()).toHaveLength(1)
  })

  it('keeps accepting while arrived and in progress, and rejects other trips and unknown ids', () => {
    matched(); drive('en_route'); drive('arrived')
    publish('d1', NOW)
    as('d1', 'start_trip', trip)
    publish('d1', NOW + 5000)
    expect(stored()).toMatchObject([{ updated_at: NOW + 5000 }])
    publish('d1', NOW + 10_000, {}, { rider_id: 'rider-1', trip_id: 'nope:trip' })
    publish('d1', NOW + 10_000, {}, { rider_id: 'rider-2', trip_id: 'r1:trip' })
    expect(stored()).toMatchObject([{ updated_at: NOW + 5000 }])
  })

  it('throttles to one update per 3 seconds', () => {
    matched(); drive('en_route')
    publish('d1', NOW, { lat: -33.8, lng: 151.1 })
    publish('d1', NOW + 2999, { lat: -33.7, lng: 151.2 })
    expect(stored()).toMatchObject([{ lat: -33.8, lng: 151.1, updated_at: NOW }])
    publish('d1', NOW + 3000, { lat: -33.7, lng: 151.2 })
    expect(stored()).toMatchObject([{ lat: -33.7, lng: 151.2, updated_at: NOW + 3000 }])
  })

  it('stores only the latest position, rounded to about 11 metres, with no trail', () => {
    matched(); drive('en_route')
    for (let i = 0; i < 5; i++) publish('d1', NOW + i * 3000, { lat: -33.86881234 - i * 0.001 })
    expect(count(db, 'trip_locations')).toBe(1)
    expect(stored()).toEqual([{ lat: -33.8728, lng: 151.2093, accuracy_m: 8, speed_mps: 11, updated_at: NOW + 12_000, driver_id: 'd1' }])
  })

  it('drops implausible coordinates, accuracy and speed', () => {
    matched(); drive('en_route')
    publish('d1', NOW, { lat: 95 })
    publish('d1', NOW, { lng: -181 })
    publish('d1', NOW, { accuracy_m: 501 })
    publish('d1', NOW, { accuracy_m: -1 })
    publish('d1', NOW, { speed_mps: 71 })
    publish('d1', NOW, { speed_mps: -2 })
    expect(stored()).toEqual([])
    publish('d1', NOW, { accuracy_m: undefined, speed_mps: undefined }) // both optional
    expect(stored()).toHaveLength(1)
  })

  it('only the trip\'s rider can read it, with a server-measured age', () => {
    matched(); drive('en_route')
    publish('d1', NOW)
    expect(read('rider-1', NOW + 7500)).toEqual([{ lat: -33.8688, lng: 151.2093, accuracy_m: 8, speed_mps: 11, age_ms: 7500, trip_status: 'en_route' }])
    expect(read('rider-2')).toEqual([])
    expect(read('d1')).toEqual([]) // the driver gets no read path
    expect(read('ops')).toEqual([])
    makeDriver('d2')
    expect(read('d2')).toEqual([])
  })

  it('is invisible before the driver starts driving, and nothing is shown for another rider\'s id', () => {
    matched()
    expect(read()).toEqual([])
    drive('en_route'); publish('d1', NOW)
    matched('r2', 'rider-2', 'd3')
    expect(read('rider-2', NOW, 'r1')).toEqual([]) // r1 belongs to rider-1
  })

  it.each([
    ['completion', () => { drive('arrived'); as('d1', 'start_trip', trip); drive('completed') }],
    ['rider cancellation', () => as('rider-1', 'cancel_ride', { request_id: 'r1' })],
    ['driver cancellation', () => as('d1', 'driver_cancel_trip', { ...trip, reason_code: 'safety' })],
    ['rider no-show', () => { drive('arrived'); as('d1', 'report_rider_no_show', trip, NOW + 6 * 60_000) }],
    ['ops cancellation', () => as('ops', 'ops_cancel_trip', { ...trip, reason_code: 'safety_incident', note: 'incident' })],
  ])('deletes the live location on %s', (_name, end) => {
    matched(); drive('en_route'); publish('d1', NOW)
    expect(stored()).toHaveLength(1)
    end()
    expect(stored()).toEqual([])
    expect(read('rider-1', NOW + 1000)).toEqual([])
    publish('d1', NOW + 10_000) // no longer accepted
    expect(stored()).toEqual([])
  })

  it('deletes the live location on a driver no-show report', () => {
    matched(); drive('en_route'); publish('d1', NOW)
    as('rider-1', 'report_driver_no_show', { request_id: 'r1' }, NOW + 16 * 60_000)
    expect(stored()).toEqual([])
  })

  it('purges positions older than 24 hours whenever anyone publishes', () => {
    matched(); drive('en_route'); publish('d1', NOW)
    matched('r2', 'rider-2', 'd2')
    as('d2', 'advance_trip', { rider_id: 'rider-2', trip_id: 'r2:trip', to_status: 'en_route' })
    as('d2', 'publish_driver_location', { rider_id: 'rider-2', trip_id: 'r2:trip', lat: -33.8, lng: 151.2 }, NOW + DAY + 1)
    expect(db.prepare('SELECT trip_id FROM trip_locations').all()).toEqual([{ trip_id: 'r2:trip' }])
  })

  it('does not disturb other trips when one ends', () => {
    matched(); drive('en_route'); publish('d1', NOW)
    matched('r2', 'rider-2', 'd2')
    as('d2', 'advance_trip', { rider_id: 'rider-2', trip_id: 'r2:trip', to_status: 'en_route' })
    as('d2', 'publish_driver_location', { rider_id: 'rider-2', trip_id: 'r2:trip', lat: -33.8, lng: 151.2 }, NOW)
    as('rider-1', 'cancel_ride', { request_id: 'r1' })
    expect(db.prepare('SELECT trip_id FROM trip_locations').all()).toEqual([{ trip_id: 'r2:trip' }])
  })

  it('account deletion removes the live location and every later table the rider owns', () => {
    matched(); drive('en_route'); publish('d1', NOW)
    as('rider-1', 'cancel_ride', { request_id: 'r1' })
    publish('d1', NOW + 5000)
    as('rider-1', 'open_dispute', { ...trip, reason_code: 'other' }, NOW + 6000)
    as('rider-1', 'delete_my_rider_data')
    for (const table of ['trips', 'trip_locations', 'trip_lifecycle', 'trip_lifecycle_events', 'trip_disputes', 'dispatch_offers', 'dispatch_requests', 'ride_requests'])
      expect(count(db, table), table).toBe(0)
  })

  it('a driver deleting their account erases their licence data, vehicles and location, and clears their live position', () => {
    matched(); drive('en_route'); publish('d1', NOW)
    as('d1', 'delete_my_driver_data')
    for (const table of ['driver_applications', 'driver_vehicles', 'driver_availability', 'driver_locations', 'trip_locations'])
      expect(count(db, table), table).toBe(0)
    expect(count(db, 'driver_review_log')).toBeGreaterThan(0) // audit trail is retained
  })

  it('fare quotes are erased with the account', () => {
    as('rider-1', 'create_quote', { quote_id: 'q', vehicle_class: 'share', pickup_label: 'A', pickup_lat: SYDNEY.lat, pickup_lng: SYDNEY.lng, dropoff_label: 'B', dropoff_lat: SYDNEY.lat + 0.045, dropoff_lng: SYDNEY.lng, distance_m: 5000, duration_s: 600 })
    expect(count(db, 'fare_quotes')).toBe(1)
    as('rider-1', 'delete_my_rider_data')
    expect(count(db, 'fare_quotes')).toBe(0)
  })
})

describe('fare statements, adjustments, receipts and reconciliation', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const MIN = 60_000
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)
  const makeDriver = (id: string) => {
    as(id, 'save_driver_application', { full_name: id, phone: '1', licence_number: id, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: id, make: 'T', model: 'C', vehicle_class: 'share' })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
    as(id, 'update_driver_location', { ...SYDNEY, service_radius_km: 10 })
    as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })
  }
  const matched = (id = 'r1', rider = 'rider-1', driver = 'd1', fareCents = 1500) => {
    if (!db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(driver)) makeDriver(driver)
    db.prepare('UPDATE driver_availability SET available = CASE WHEN user_id = ? THEN 1 ELSE 0 END').run(driver) // only this driver can be offered the ride
    as(rider, 'save_ride', { ...rideToRecords({ id, pickup: 'Central', pickupCoord: SYDNEY, dropoff: 'Airport', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents }) })
    as(rider, 'request_dispatch', { request_id: id })
    as(rider, 'dispatch_tick', { request_id: id })
    as(driver, 'accept_offer', { rider_id: rider, request_id: id })
  }
  const tripOf = (id = 'r1', rider = 'rider-1') => ({ rider_id: rider, trip_id: `${id}:trip` })
  const step = (to: string, driver = 'd1', id = 'r1', rider = 'rider-1', now = NOW) => as(driver, 'advance_trip', { ...tripOf(id, rider), to_status: to }, now)
  const complete = (id = 'r1', rider = 'rider-1', driver = 'd1') => {
    step('en_route', driver, id, rider); step('arrived', driver, id, rider)
    as(driver, 'start_trip', tripOf(id, rider))
    step('completed', driver, id, rider)
  }
  const statements = () => db.prepare('SELECT * FROM fare_statements ORDER BY trip_id').all() as Record<string, unknown>[]
  const statement = (trip = 'r1:trip') => db.prepare('SELECT * FROM fare_statements WHERE trip_id = ?').get(trip) as Record<string, unknown> | undefined
  const issues = () => as('ops', 'ops_reconcile') as { trip_id: string; code: string }[]
  const credit = (extra: Record<string, unknown> = {}, who = 'ops') =>
    as(who, 'ops_credit_trip', { ...tripOf(), request_key: 'k1', amount_cents: 300, reason_code: 'goodwill', note: 'sorry', ...extra })

  describe('finalization', () => {
    it('writes one immutable statement when a trip completes, from the accepted quote', () => {
      matched('r1', 'rider-1', 'd1', 1500)
      expect(statements()).toEqual([]) // nothing while the trip is open
      complete()
      expect(statements()).toHaveLength(1)
      expect(statement()).toMatchObject({ rider_id: 'rider-1', request_id: 'r1', driver_user_id: 'd1', basis: 'fare', currency: 'USD', quoted_cents: 1500, final_cents: 1500, tax_rate_bp: 0, tax_cents: 0, commission_bp: 0, platform_fee_cents: 0, driver_payout_cents: 1500, policy_version: 'v0-unconfigured', outcome: 'completed', pickup_label: 'Central', dropoff_label: 'Airport', finalized_at: NOW })
      expect(String(statement()?.receipt_no)).toMatch(/^RCT-[0-9a-f]{8}$/)
      expect(issues()).toEqual([])
    })

    it('snapshots the quote components when the ride came from a server quote', () => {
      makeDriver('d1')
      as('rider-1', 'create_quote', { quote_id: 'q1', vehicle_class: 'share', pickup_label: 'Central', pickup_lat: SYDNEY.lat, pickup_lng: SYDNEY.lng, dropoff_label: 'Airport', dropoff_lat: SYDNEY.lat + 0.045, dropoff_lng: SYDNEY.lng, distance_m: 5000, duration_s: 600 })
      as('rider-1', 'accept_quote', { quote_id: 'q1', ride_id: 'ride-q', client_record: '{}', pickup_lat: SYDNEY.lat, pickup_lng: SYDNEY.lng, dropoff_lat: SYDNEY.lat + 0.045, dropoff_lng: SYDNEY.lng, distance_m: 5000 })
      as('rider-1', 'dispatch_tick', { request_id: 'ride-q' })
      as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'ride-q' })
      complete('ride-q')
      expect(statement('ride-q:trip')).toMatchObject({ quote_id: 'q1', quoted_cents: 1150, base_cents: 200, distance_cents: 550, time_cents: 250, booking_fee_cents: 150, min_adjust_cents: 0, surge_milli: 1000, final_cents: 1150, basis: 'fare' })
      expect(issues()).toEqual([])
    })

    it.each([
      ['rider cancels in the grace period', () => as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 60_000), 'none', 0, 'rider_cancelled'],
      ['rider cancels late', () => as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 3 * MIN), 'cancellation_fee', 500, 'rider_cancelled'],
      ['rider cancels after the driver arrived', () => { step('en_route'); step('arrived'); as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + MIN) }, 'cancellation_fee', 800, 'rider_cancelled'],
      ['driver cancels', () => as('d1', 'driver_cancel_trip', { ...tripOf(), reason_code: 'safety' }), 'none', 0, 'driver_cancelled'],
      ['rider does not show', () => { step('en_route'); step('arrived'); as('d1', 'report_rider_no_show', tripOf(), NOW + 6 * MIN) }, 'no_show_fee', 800, 'rider_no_show'],
      ['driver does not show', () => as('rider-1', 'report_driver_no_show', { request_id: 'r1' }, NOW + 16 * MIN), 'none', 0, 'driver_no_show'],
      ['ops cancels with a fee', () => as('ops', 'ops_cancel_trip', { ...tripOf(), reason_code: 'fraud_suspected', note: 'incident', fee_cents: 400 }), 'cancellation_fee', 400, 'ops_cancelled'],
    ])('finalizes a statement when %s', (_name, end, basis, fee, outcome) => {
      matched('r1', 'rider-1', 'd1', 1500)
      end()
      expect(statement()).toMatchObject({ basis, final_cents: fee, driver_payout_cents: fee, outcome })
      expect(issues()).toEqual([])
    })

    it('refused and repeated calls create no statement and never a second one', () => {
      matched()
      step('arrived') // out of order
      as('d1', 'advance_trip', { ...tripOf(), to_status: 'completed' })
      expect(statements()).toEqual([])
      complete()
      step('completed') // repeat
      as('rider-1', 'cancel_ride', { request_id: 'r1' }) // cannot cancel a finished trip
      as('d1', 'driver_cancel_trip', { ...tripOf(), reason_code: 'other' })
      expect(statements()).toHaveLength(1)
      expect(statement()).toMatchObject({ basis: 'fare', final_cents: 1500 })
    })

    it('never changes after the fact: later edits to the quote or lifecycle leave it as it was, and reconciliation flags the drift', () => {
      matched(); complete()
      const before = statement()
      db.prepare("UPDATE quotes SET fare_cents = 9999 WHERE request_id = 'r1'").run()
      as('rider-1', 'save_ride', { ...rideToRecords({ id: 'r1', pickup: 'Edited', pickupCoord: SYDNEY, dropoff: 'Edited', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 7777 }) }, NOW + 10_000)
      expect(statement()).toEqual(before)
      expect(issues()).toEqual([{ rider_id: 'rider-1', trip_id: 'r1:trip', code: 'quote_changed', detail: expect.any(String) }].map(({ trip_id, code }) => ({ trip_id, code })).map((i) => expect.objectContaining(i)))
    })

    it('uses distinct receipt numbers', () => {
      matched('r1'); complete('r1')
      matched('r2', 'rider-2', 'd2'); complete('r2', 'rider-2', 'd2')
      const numbers = statements().map((s) => s.receipt_no)
      expect(new Set(numbers).size).toBe(2)
    })
  })

  describe('receipts', () => {
    it('shows the rider the statement, scoped to their own rides', () => {
      matched(); complete()
      const [receipt] = as('rider-1', 'get_receipt', { request_id: 'r1' }) as Record<string, unknown>[]
      expect(receipt).toMatchObject({ trip_id: 'r1:trip', basis: 'fare', final_cents: 1500, credits_cents: 0, total_cents: 1500, tax_cents: 0, pickup_label: 'Central', dropoff_label: 'Airport' })
      expect(as('rider-2', 'get_receipt', { request_id: 'r1' })).toEqual([])
      expect(as('d1', 'get_receipt', { request_id: 'r1' })).toEqual([])
      expect(as('rider-1', 'list_my_receipts')).toHaveLength(1)
      expect(as('rider-2', 'list_my_receipts')).toEqual([])
    })

    it('gives the driver an accrual view of only their own trips', () => {
      matched(); complete()
      matched('r2', 'rider-2', 'd2'); complete('r2', 'rider-2', 'd2')
      expect(as('d1', 'list_my_earnings')).toMatchObject([{ trip_id: 'r1:trip', final_cents: 1500, driver_payout_cents: 1500, platform_fee_cents: 0, policy_version: 'v0-unconfigured' }])
      expect(as('rider-1', 'list_my_earnings')).toEqual([])
    })
  })

  describe('credits', () => {
    it('credits part of a finished trip without touching the statement', () => {
      matched(); complete()
      const before = statement()
      credit({ amount_cents: 300 })
      credit({ request_key: 'k2', amount_cents: 200, reason_code: 'fare_error' })
      expect(statement()).toEqual(before)
      expect(as('rider-1', 'get_receipt', { request_id: 'r1' })).toMatchObject([{ final_cents: 1500, credits_cents: 500, total_cents: 1000 }])
      expect(as('rider-1', 'list_receipt_adjustments', { trip_id: 'r1:trip' })).toMatchObject([{ kind: 'credit', amount_cents: 300, reason_code: 'goodwill' }, { amount_cents: 200, reason_code: 'fare_error' }])
      expect(issues()).toEqual([])
    })

    it('can never exceed the final amount, in one credit or across several', () => {
      matched(); complete()
      credit({ request_key: 'a', amount_cents: 1501 })
      expect(count(db, 'fare_adjustments')).toBe(0)
      credit({ request_key: 'b', amount_cents: 1000 })
      credit({ request_key: 'c', amount_cents: 501 })
      expect(count(db, 'fare_adjustments')).toBe(1)
      credit({ request_key: 'd', amount_cents: 500 })
      expect(as('rider-1', 'get_receipt', { request_id: 'r1' })).toMatchObject([{ total_cents: 0 }])
      credit({ request_key: 'e', amount_cents: 1 })
      expect(count(db, 'fare_adjustments')).toBe(2)
    })

    it('rejects invalid input: no amount, bad reason, no note, no key, unfinished trips', () => {
      matched()
      credit() // trip not finished: no statement
      complete()
      credit({ amount_cents: 0 }); credit({ amount_cents: -5 })
      credit({ reason_code: 'dispute_waiver' }) // reserved for the dispute flow
      credit({ reason_code: 'bribe' })
      credit({ note: '  ' }); credit({ request_key: '  ' })
      credit({ trip_id: 'nope:trip' }); credit({ rider_id: 'rider-9' })
      expect(count(db, 'fare_adjustments')).toBe(0)
    })

    it('is idempotent on the request key, so a retry never double-credits', () => {
      matched(); complete()
      credit(); credit(); credit({ amount_cents: 999 }) // same key, even with a different amount
      expect(as('rider-1', 'list_receipt_adjustments', { trip_id: 'r1:trip' })).toHaveLength(1)
      expect(as('rider-1', 'get_receipt', { request_id: 'r1' })).toMatchObject([{ credits_cents: 300 }])
    })

    it('is ops-only in the manifest, and ops cannot credit trips they rode or drove', () => {
      expect(tool('ops_credit_trip')).toMatchObject({ auth: { required: true, app_roles: ['ops'] } })
      expect(tool('ops_reconcile')).toMatchObject({ auth: { required: true, app_roles: ['ops'] } })
      matched('r1', 'ops-rider', 'd1'); complete('r1', 'ops-rider')
      as('ops-rider', 'ops_credit_trip', { ...tripOf('r1', 'ops-rider'), request_key: 'k', amount_cents: 100, reason_code: 'goodwill', note: 'self' })
      as('d1', 'ops_credit_trip', { ...tripOf('r1', 'ops-rider'), request_key: 'k', amount_cents: 100, reason_code: 'goodwill', note: 'self' })
      expect(count(db, 'fare_adjustments')).toBe(0)
      expect(as('ops-rider', 'ops_reconcile')).toEqual([])
    })

    it('a dispute fee waiver becomes a credit against the unchanged statement and reconciles', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 3 * MIN)
      expect(statement()).toMatchObject({ basis: 'cancellation_fee', final_cents: 500 })
      as('rider-1', 'open_dispute', { ...tripOf(), reason_code: 'cancel_fee' }, NOW + 4 * MIN)
      as('ops', 'ops_resolve_dispute', { ...tripOf(), opened_by: 'rider-1', decision: 'upheld', note: 'driver was late', waive_fee: 1 }, NOW + 5 * MIN)
      expect(statement()).toMatchObject({ final_cents: 500 })
      expect(as('rider-1', 'get_receipt', { request_id: 'r1' })).toMatchObject([{ final_cents: 500, credits_cents: 500, total_cents: 0 }])
      expect(as('rider-1', 'list_receipt_adjustments', { trip_id: 'r1:trip' })).toMatchObject([{ reason_code: 'dispute_waiver', amount_cents: 500 }])
      expect(issues()).toEqual([])
    })

    it('a rejected dispute leaves the receipt alone', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 3 * MIN)
      as('rider-1', 'open_dispute', { ...tripOf(), reason_code: 'cancel_fee' }, NOW + 4 * MIN)
      as('ops', 'ops_resolve_dispute', { ...tripOf(), opened_by: 'rider-1', decision: 'rejected', note: 'policy applied', waive_fee: 1 }, NOW + 5 * MIN)
      expect(count(db, 'fare_adjustments')).toBe(0)
      expect(as('rider-1', 'get_receipt', { request_id: 'r1' })).toMatchObject([{ total_cents: 500 }])
    })
  })

  describe('reconciliation', () => {
    const codes = () => issues().map((i) => i.code)

    it('is clean across completed, cancelled, credited and no-show trips', () => {
      matched('r1'); complete('r1')
      matched('r2', 'rider-2', 'd2'); as('rider-2', 'cancel_ride', { request_id: 'r2' }, NOW + 3 * MIN)
      matched('r3', 'rider-3', 'd3'); as('d3', 'driver_cancel_trip', { ...tripOf('r3', 'rider-3'), reason_code: 'other' })
      credit({ amount_cents: 100 })
      expect(issues()).toEqual([])
    })

    it('flags a finished trip with no statement', () => {
      matched(); complete()
      db.prepare('DELETE FROM fare_statements').run()
      expect(codes()).toEqual(['missing_statement'])
    })

    it.each([
      ['fare_not_quote', "UPDATE fare_statements SET final_cents = 1400, driver_payout_cents = 1400"],
      ['payout_mismatch', 'UPDATE fare_statements SET driver_payout_cents = 1000'],
      ['credits_exceed_final', "INSERT INTO fare_adjustments (rider_id, id, trip_id, kind, amount_cents, reason_code, actor_id, created_at) VALUES ('rider-1', 'x', 'r1:trip', 'credit', 2000, 'other', 'ops', 1)"],
      ['refunds_without_payment', "INSERT INTO fare_adjustments (rider_id, id, trip_id, kind, amount_cents, reason_code, actor_id, created_at) VALUES ('rider-1', 'x', 'r1:trip', 'refund', 100, 'other', 'ops', 1)"],
      ['adjustment_without_statement', "INSERT INTO fare_adjustments (rider_id, id, trip_id, kind, amount_cents, reason_code, actor_id, created_at) VALUES ('rider-1', 'x', 'ghost:trip', 'credit', 100, 'other', 'ops', 1)"],
    ])('detects %s', (code, sql) => {
      matched(); complete()
      db.prepare(sql).run()
      expect(codes()).toContain(code)
    })

    it('detects component totals that do not add up to the quote', () => {
      makeDriver('d1')
      as('rider-1', 'create_quote', { quote_id: 'q1', vehicle_class: 'share', pickup_label: 'A', pickup_lat: SYDNEY.lat, pickup_lng: SYDNEY.lng, dropoff_label: 'B', dropoff_lat: SYDNEY.lat + 0.045, dropoff_lng: SYDNEY.lng, distance_m: 5000, duration_s: 600 })
      as('rider-1', 'accept_quote', { quote_id: 'q1', ride_id: 'ride-q', client_record: '{}', pickup_lat: SYDNEY.lat, pickup_lng: SYDNEY.lng, dropoff_lat: SYDNEY.lat + 0.045, dropoff_lng: SYDNEY.lng, distance_m: 5000 })
      as('rider-1', 'dispatch_tick', { request_id: 'ride-q' })
      as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'ride-q' })
      complete('ride-q')
      db.prepare('UPDATE fare_statements SET distance_cents = 9999').run()
      expect(codes()).toContain('components_mismatch')
    })

    it('detects a cancellation fee that no longer matches the lifecycle', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 3 * MIN)
      db.prepare('UPDATE trip_lifecycle SET cancel_fee_cents = 0').run()
      expect(codes()).toEqual(['fee_not_lifecycle'])
    })
  })

  describe('immutability and privacy', () => {
    const tools = mcpFile.tools as unknown as { name: string; sql?: string; statements?: string[] }[]
    const allSql = () => tools.flatMap((t) => (t.statements ?? [t.sql!]).map((sql) => ({ tool: t.name, sql })))

    it('no action edits or deletes statements or adjustments, other than whole-account deletion', () => {
      for (const { tool: name, sql } of allSql()) {
        if (name === 'delete_my_rider_data') continue
        expect(sql, name).not.toMatch(/UPDATE\s+fare_statements/i)
        expect(sql, name).not.toMatch(/DELETE\s+FROM\s+fare_statements/i)
        expect(sql, name).not.toMatch(/UPDATE\s+fare_adjustments/i)
        expect(sql, name).not.toMatch(/DELETE\s+FROM\s+fare_adjustments/i)
        if (/INSERT\s+(OR\s+IGNORE\s+)?INTO\s+fare_statements/i.test(sql)) expect(sql, name).toMatch(/INSERT OR IGNORE/)
      }
    })

    it('statements can only be created by actions that end a trip', () => {
      const writers = new Set(allSql().filter(({ sql }) => /INTO\s+fare_statements/i.test(sql)).map(({ tool: name }) => name))
      expect([...writers].sort()).toEqual(['advance_trip', 'cancel_ride', 'driver_cancel_trip', 'ops_cancel_trip', 'report_driver_no_show', 'report_rider_no_show'])
    })

    it('account deletion removes the rider\'s ledger with the rest of their data', () => {
      matched(); complete(); credit()
      as('rider-1', 'delete_my_rider_data')
      expect(count(db, 'fare_statements')).toBe(0)
      expect(count(db, 'fare_adjustments')).toBe(0)
    })

    it('no action takes payment credentials or card data', () => {
      const forbidden = /card|cvc|cvv|pan\b|iban|account_number|routing_number|secret|api_key|token/i
      for (const t of mcpFile.tools as unknown as { name: string; params?: Record<string, unknown> }[])
        for (const param of Object.keys(t.params ?? {})) expect(param, `${t.name}.${param}`).not.toMatch(forbidden)
      const columns = (db.prepare("SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'").all() as { tbl: string; col: string }[])
      for (const { tbl, col } of columns) expect(col, `${tbl}.${col}`).not.toMatch(/card|cvc|cvv|iban|account_number|routing_number|secret|api_key/i)
    })
  })
})

describe('notifications', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const MIN = 60_000
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)
  const makeDriver = (id: string) => {
    as(id, 'save_driver_application', { full_name: `Driver ${id}`, phone: '1', licence_number: id, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: `PL-${id}`, make: 'T', model: 'C', vehicle_class: 'share' })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
    as(id, 'update_driver_location', { ...SYDNEY, service_radius_km: 10 })
    as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })
  }
  const request = (id = 'r1', rider = 'rider-1', driver = 'd1') => {
    if (!db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(driver)) makeDriver(driver)
    db.prepare('UPDATE driver_availability SET available = CASE WHEN user_id = ? THEN 1 ELSE 0 END').run(driver)
    as(rider, 'save_ride', { ...rideToRecords({ id, pickup: 'Central', pickupCoord: SYDNEY, dropoff: 'Airport', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1500 }) })
    as(rider, 'request_dispatch', { request_id: id })
  }
  const matched = (id = 'r1', rider = 'rider-1', driver = 'd1') => {
    request(id, rider, driver)
    as(rider, 'dispatch_tick', { request_id: id })
    as(driver, 'accept_offer', { rider_id: rider, request_id: id })
  }
  const trip = (id = 'r1', rider = 'rider-1') => ({ rider_id: rider, trip_id: `${id}:trip` })
  const step = (to: string, driver = 'd1', now = NOW) => as(driver, 'advance_trip', { ...trip(), to_status: to }, now)
  const inbox = (user: string) => db.prepare('SELECT id, kind, role, trip_id, request_id, rider_id, link, params, critical, actor_id FROM notifications WHERE user_id = ? ORDER BY created_at, id').all(user) as Record<string, unknown>[]
  const kinds = (user: string) => inbox(user).map((n) => n.kind)
  const row = (user: string, id: string) => db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id = ?').get(user, id) as Record<string, unknown>

  describe('events', () => {
    it('tells the driver about a new offer, once, linking to the driver home', () => {
      request()
      as('rider-1', 'dispatch_tick', { request_id: 'r1' })
      as('rider-1', 'dispatch_tick', { request_id: 'r1' })
      as('rider-1', 'dispatch_tick', { request_id: 'r1' })
      expect(inbox('d1')).toHaveLength(1)
      expect(inbox('d1')[0]).toMatchObject({ kind: 'offer_received', role: 'driver', link: '/driver', request_id: 'r1', rider_id: 'rider-1', critical: 0, actor_id: 'rider-1' })
      expect(JSON.parse(inbox('d1')[0].params as string)).toMatchObject({ pickup: 'Central', dropoff: 'Airport' })
      expect(inbox('rider-1')).toEqual([])
    })

    it('tells the rider the driver was assigned, with the driver and plate, linking to the trip', () => {
      matched()
      expect(inbox('rider-1')).toHaveLength(1)
      expect(inbox('rider-1')[0]).toMatchObject({ kind: 'driver_assigned', role: 'rider', link: '/trip/r1', trip_id: 'r1:trip', request_id: 'r1', critical: 1, actor_id: 'd1' })
      expect(JSON.parse(inbox('rider-1')[0].params as string)).toEqual({ driver: 'Driver d1', plate: 'PL-d1' })
      as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'r1' }) // replay
      expect(inbox('rider-1')).toHaveLength(1)
    })

    it('follows the trip: en route, arrived, started, and a receipt on completion', () => {
      matched()
      step('en_route'); step('arrived'); as('d1', 'start_trip', trip()); step('completed')
      expect(kinds('rider-1')).toEqual(expect.arrayContaining(['driver_assigned', 'driver_en_route', 'driver_arrived', 'trip_started', 'receipt_ready']))
      expect(inbox('rider-1')).toHaveLength(5)
      expect(inbox('rider-1').find((n) => n.kind === 'driver_arrived')).toMatchObject({ critical: 1, link: '/trip/r1' })
      expect(inbox('rider-1').find((n) => n.kind === 'driver_en_route')).toMatchObject({ critical: 0 })
      expect(JSON.parse(inbox('rider-1').find((n) => n.kind === 'receipt_ready')!.params as string)).toEqual({ total_cents: 1500 })
      expect(inbox('d1').map((n) => n.kind)).toEqual(['offer_received']) // the driver is never told about their own actions
    })

    it('refused and repeated transitions queue nothing', () => {
      matched()
      step('arrived') // skips en_route
      as('d1', 'start_trip', trip()) // not arrived
      step('completed') // not started
      expect(kinds('rider-1')).toEqual(['driver_assigned'])
      step('en_route'); step('en_route'); step('en_route', 'd2'); as('rider-1', 'advance_trip', { ...trip(), to_status: 'arrived' })
      expect(kinds('rider-1')).toEqual(['driver_assigned', 'driver_en_route'])
    })

    it.each([
      ['the rider cancels', () => as('rider-1', 'cancel_ride', { request_id: 'r1', reason_code: 'wait_too_long' }, NOW + 3 * MIN), 'd1', 'trip_cancelled', { by: 'rider', reason: 'wait_too_long', fee_cents: 500 }, '/driver/trip/rider-1/r1'],
      ['the driver cancels', () => as('d1', 'driver_cancel_trip', { ...trip(), reason_code: 'vehicle_issue' }), 'rider-1', 'trip_cancelled', { by: 'driver', reason: 'vehicle_issue', fee_cents: 0 }, '/trip/r1'],
      ['the driver reports a rider no-show', () => { step('en_route'); step('arrived'); as('d1', 'report_rider_no_show', trip(), NOW + 6 * MIN) }, 'rider-1', 'rider_no_show', { fee_cents: 800 }, '/trip/r1'],
      ['the rider reports a driver no-show', () => as('rider-1', 'report_driver_no_show', { request_id: 'r1' }, NOW + 16 * MIN), 'd1', 'driver_no_show', {}, '/driver/trip/rider-1/r1'],
    ])('when %s, tells only the other party', (_name, act, recipient, kind, params, link) => {
      matched()
      act()
      const n = inbox(recipient).find((x) => x.kind === kind)
      expect(n).toMatchObject({ critical: 1, link, trip_id: 'r1:trip' })
      expect(JSON.parse(n!.params as string)).toEqual(params)
      const actor = recipient === 'd1' ? 'rider-1' : 'd1'
      expect(inbox(actor).filter((x) => ['trip_cancelled', 'rider_no_show', 'driver_no_show'].includes(x.kind as string))).toEqual([])
    })

    it('an ops cancellation tells both the rider and the driver', () => {
      matched()
      as('ops', 'ops_cancel_trip', { ...trip(), reason_code: 'safety_incident', note: 'incident', fee_cents: 0 })
      expect(inbox('rider-1').find((n) => n.kind === 'trip_cancelled')).toMatchObject({ role: 'rider', link: '/trip/r1' })
      expect(inbox('d1').find((n) => n.kind === 'trip_cancelled')).toMatchObject({ role: 'driver', link: '/driver/trip/rider-1/r1' })
    })

    it('a cancellation before any driver is assigned tells no one', () => {
      request()
      as('rider-1', 'cancel_ride', { request_id: 'r1' })
      expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'trip_cancelled'").get()).toEqual({ n: 0 })
    })

    it('a cancellation is notified once even if repeated', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 1)
      as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 2)
      expect(inbox('d1').filter((n) => n.kind === 'trip_cancelled')).toHaveLength(1)
    })

    it('tells whoever opened a dispute how it was decided, linking to their own view of the trip', () => {
      matched()
      step('en_route'); step('arrived'); as('d1', 'start_trip', trip()); step('completed')
      as('rider-1', 'open_dispute', { ...trip(), reason_code: 'overcharged' }, NOW + 1000)
      as('d1', 'open_dispute', { ...trip(), reason_code: 'rider_conduct' }, NOW + 1000)
      as('ops', 'ops_resolve_dispute', { ...trip(), opened_by: 'rider-1', decision: 'upheld', note: 'ok', waive_fee: 0 }, NOW + 2000)
      as('ops', 'ops_resolve_dispute', { ...trip(), opened_by: 'd1', decision: 'rejected', note: 'no', waive_fee: 0 }, NOW + 2000)
      expect(inbox('rider-1').find((n) => n.kind === 'dispute_resolved')).toMatchObject({ link: '/trip/r1', role: 'rider' })
      expect(JSON.parse(inbox('rider-1').find((n) => n.kind === 'dispute_resolved')!.params as string)).toEqual({ decision: 'upheld' })
      expect(inbox('d1').find((n) => n.kind === 'dispute_resolved')).toMatchObject({ link: '/driver/trip/rider-1/r1' })
      expect(JSON.parse(inbox('d1').find((n) => n.kind === 'dispute_resolved')!.params as string)).toEqual({ decision: 'rejected' })
      as('ops', 'ops_resolve_dispute', { ...trip(), opened_by: 'rider-1', decision: 'rejected', note: 'again', waive_fee: 0 }, NOW + 3000) // already resolved
      expect(inbox('rider-1').filter((n) => n.kind === 'dispute_resolved')).toHaveLength(1)
    })

    it('keeps notifications separate per person', () => {
      matched('r1', 'rider-1', 'd1')
      matched('r2', 'rider-2', 'd2')
      expect(inbox('rider-1').every((n) => n.rider_id === 'rider-1')).toBe(true)
      expect(inbox('rider-2').every((n) => n.rider_id === 'rider-2')).toBe(true)
      expect(as('rider-1', 'list_my_notifications')).toHaveLength(1)
      expect(as('rider-2', 'list_my_notifications')).toHaveLength(1)
      expect(as('d3', 'list_my_notifications')).toEqual([])
    })
  })

  describe('inbox', () => {
    it('marks one or all read, only for the owner, and purges after 30 days', () => {
      matched(); step('en_route')
      const ids = (as('rider-1', 'list_my_notifications') as { id: string }[]).map((n) => n.id)
      as('rider-2', 'mark_notifications_read', {})
      expect(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NOT NULL').get()).toEqual({ n: 0 })
      as('rider-1', 'mark_notifications_read', { id: ids[0] }, NOW + 5)
      expect((as('rider-1', 'list_my_notifications') as { read_at: number | null }[]).filter((n) => n.read_at !== null)).toHaveLength(1)
      as('rider-1', 'mark_notifications_read', {}, NOW + 6)
      expect((as('rider-1', 'list_my_notifications') as { read_at: number | null }[]).every((n) => n.read_at !== null)).toBe(true)
      as('rider-1', 'mark_notifications_read', {}, NOW + 30 * 24 * 60 * MIN + 1)
      expect(as('rider-1', 'list_my_notifications')).toEqual([])
    })

    it('is erased with the account, along with preferences', () => {
      matched()
      as('rider-1', 'set_notification_prefs', { locale: 'es', push: 1, email_fallback: 1 })
      as('rider-1', 'delete_my_rider_data')
      expect(count(db, 'notification_prefs')).toBe(0)
      expect(inbox('rider-1')).toEqual([])
      expect(inbox('d1')).toHaveLength(1) // the driver's own offer is theirs
    })
  })

  describe('preferences and consent', () => {
    const prefs = (user = 'rider-1') => as(user, 'get_notification_prefs')[0] as Record<string, unknown> | undefined

    it('defaults to push on and email off, with no consent recorded', () => {
      expect(prefs()).toBeUndefined()
      matched()
      expect(row('rider-1', 'r1:trip:driver_assigned')).toMatchObject({ push_status: 'pending', email_status: 'none' })
    })

    it('records email consent with its time, keeps the first time, and clears it on withdrawal', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 1, email_fallback: 1 }, NOW)
      expect(prefs()).toMatchObject({ email_fallback: 1, email_consent_at: NOW })
      as('rider-1', 'set_notification_prefs', { locale: 'es', push: 1, email_fallback: 1 }, NOW + 5000)
      expect(prefs()).toMatchObject({ locale: 'es', email_consent_at: NOW })
      as('rider-1', 'set_notification_prefs', { locale: 'es', push: 1, email_fallback: 0 }, NOW + 6000)
      expect(prefs()).toMatchObject({ email_fallback: 0, email_consent_at: null })
    })

    it('rejects unknown languages and invalid flags', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'xx', push: 1, email_fallback: 0 })
      expect(prefs()).toMatchObject({ locale: 'en' })
      expect(() => as('rider-1', 'set_notification_prefs', { locale: 'en', push: 2, email_fallback: 0 })).toThrow()
      expect(() => as('rider-1', 'set_notification_prefs', { locale: 'en', push: 1, email_fallback: 1.5 as number })).toThrow()
    })

    it('skips push for someone who turned it off, and queues email only for a consenting person', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 0 })
      as('rider-2', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 1 })
      matched('r1', 'rider-1', 'd1'); matched('r2', 'rider-2', 'd2')
      expect(row('rider-1', 'r1:trip:driver_assigned')).toMatchObject({ push_status: 'skipped', email_status: 'none' }) // no consent, no email
      expect(row('rider-2', 'r2:trip:driver_assigned')).toMatchObject({ push_status: 'skipped', email_status: 'pending' })
    })

    it('never emails non-critical notifications', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 1 })
      matched(); step('en_route')
      expect(row('rider-1', 'r1:trip:driver_en_route')).toMatchObject({ critical: 0, email_status: 'none' })
    })

    it('withdrawing a channel takes effect on notifications already waiting', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 1, email_fallback: 1 })
      matched()
      expect(row('rider-1', 'r1:trip:driver_assigned')).toMatchObject({ push_status: 'pending' })
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 0 })
      expect(row('rider-1', 'r1:trip:driver_assigned')).toMatchObject({ push_status: 'skipped', push_next_at: null })
      expect(as('d1', 'list_pending_deliveries')).toEqual([])
    })
  })

  describe('delivery, retries and observability', () => {
    const pending = (user = 'd1', now = NOW) => as(user, 'list_pending_deliveries', {}, now) as { recipient: string; id: string; channel: string; locale: string; kind: string }[]
    const pushResult = (outcome: string, now = NOW, who = 'd1', error?: string) => as(who, 'report_push_result', { recipient: 'rider-1', notification_id: 'r1:trip:driver_assigned', outcome, error }, now)
    const emailResult = (outcome: string, now = NOW, who = 'd1', error?: string) => as(who, 'report_email_result', { recipient: 'rider-1', notification_id: 'r1:trip:driver_assigned', outcome, error }, now)
    const status = () => row('rider-1', 'r1:trip:driver_assigned')

    it('only the person whose action caused a notification can deliver or report it', () => {
      matched()
      expect(pending('d1')).toMatchObject([{ recipient: 'rider-1', id: 'r1:trip:driver_assigned', channel: 'push', kind: 'driver_assigned' }])
      expect(pending('rider-1')).toMatchObject([{ recipient: 'd1', kind: 'offer_received' }]) // the rider only owes the push their own tick caused
      expect(pending('d2')).toEqual([])
      pushResult('sent', NOW, 'rider-1'); pushResult('sent', NOW, 'ops'); pushResult('sent', NOW, 'd2')
      expect(status()).toMatchObject({ push_status: 'pending', push_attempts: 0 })
      pushResult('sent')
      expect(status()).toMatchObject({ push_status: 'sent', push_attempts: 1, push_next_at: null })
      expect(pending('d1')).toEqual([]) // delivered: not listed again
    })

    it('writes the message in the recipient\'s language', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'es', push: 1, email_fallback: 0 })
      matched()
      expect(pending('d1')[0]).toMatchObject({ locale: 'es' })
    })

    it('retries a failed push after 30 seconds, then 2 minutes, then gives up and records the error', () => {
      matched()
      pushResult('failed', NOW, 'd1', 'rate limited')
      expect(status()).toMatchObject({ push_status: 'retry', push_attempts: 1, push_next_at: NOW + 30_000, push_error: 'rate limited' })
      expect(pending('d1', NOW + 29_999)).toEqual([]) // not due yet
      expect(pending('d1', NOW + 30_000)).toHaveLength(1)
      pushResult('failed', NOW + 30_000, 'd1', 'rate limited')
      expect(status()).toMatchObject({ push_status: 'retry', push_attempts: 2, push_next_at: NOW + 30_000 + 120_000 })
      expect(pending('d1', NOW + 149_999)).toEqual([])
      pushResult('failed', NOW + 150_000, 'd1', 'x'.repeat(300))
      expect(status()).toMatchObject({ push_status: 'failed', push_attempts: 3, push_next_at: null })
      expect(String(status().push_error)).toHaveLength(100)
      expect(pending('d1', NOW + 10 * MIN)).toEqual([]) // no further attempts
      pushResult('sent', NOW + 10 * MIN) // a late success cannot resurrect it
      expect(status()).toMatchObject({ push_status: 'failed', push_attempts: 3 })
    })

    it('a success after a retry ends the cycle', () => {
      matched()
      pushResult('failed')
      pushResult('sent', NOW + 31_000)
      expect(status()).toMatchObject({ push_status: 'sent', push_attempts: 2 })
    })

    it('rejects an unknown outcome and repeated reports of a finished delivery', () => {
      matched()
      pushResult('maybe')
      expect(status()).toMatchObject({ push_attempts: 0 })
      pushResult('sent'); pushResult('sent'); pushResult('failed')
      expect(status()).toMatchObject({ push_status: 'sent', push_attempts: 1 })
    })

    it('falls back to email only after push has failed for good, for a critical notification and a consenting recipient', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 1, email_fallback: 1 })
      matched()
      expect(status()).toMatchObject({ email_status: 'none' })
      pushResult('failed'); pushResult('failed', NOW + 30_000); pushResult('failed', NOW + 150_000)
      expect(status()).toMatchObject({ push_status: 'failed', email_status: 'pending' })
      expect(pending('d1', NOW + 150_000)).toMatchObject([{ channel: 'email', id: 'r1:trip:driver_assigned' }])
    })

    it('does not email when push failed for someone who never consented', () => {
      matched()
      pushResult('failed'); pushResult('failed', NOW + 30_000); pushResult('failed', NOW + 150_000)
      expect(status()).toMatchObject({ push_status: 'failed', email_status: 'none' })
    })

    it('does not email a push that succeeded', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 1, email_fallback: 1 })
      matched(); pushResult('sent')
      expect(status()).toMatchObject({ email_status: 'none' })
    })

    it('does not send an email once consent is withdrawn', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 1 })
      matched()
      expect(pending('d1')).toMatchObject([{ channel: 'email' }])
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 0 })
      expect(pending('d1')).toEqual([])
      expect(status()).toMatchObject({ email_status: 'skipped' })
    })

    it('records email outcomes: sent, skipped when the platform says unsubscribed, and retries before failing', () => {
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 1 })
      matched()
      emailResult('sent')
      expect(status()).toMatchObject({ email_status: 'sent', email_attempts: 1 })
      db = new DatabaseSync(':memory:'); migrate(db, new Set())
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 1 })
      matched()
      emailResult('skipped', NOW, 'd1', 'unsubscribed')
      expect(status()).toMatchObject({ email_status: 'skipped', email_error: 'unsubscribed' })
      db = new DatabaseSync(':memory:'); migrate(db, new Set())
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 0, email_fallback: 1 })
      matched()
      emailResult('failed', NOW); emailResult('failed', NOW + 30_000); emailResult('failed', NOW + 150_000)
      expect(status()).toMatchObject({ email_status: 'failed', email_attempts: 3 })
      expect(as('d1', 'report_email_result', { recipient: 'rider-1', notification_id: 'r1:trip:driver_assigned', outcome: 'sent' }, NOW + MIN)).toBeUndefined()
      expect(status()).toMatchObject({ email_status: 'failed' })
    })

    it('shows ops the failures and the notifications nobody has delivered, without message content', () => {
      expect(tool('ops_list_notification_issues')).toMatchObject({ auth: { required: true, app_roles: ['ops'] } })
      as('rider-1', 'set_notification_prefs', { locale: 'en', push: 1, email_fallback: 1 })
      matched()
      const mineOnly = (now: number) => (as('ops', 'ops_list_notification_issues', {}, now) as { user_id: string }[]).filter((i) => i.user_id === 'rider-1')
      expect(as('ops', 'ops_list_notification_issues', {}, NOW + 5 * MIN)).toEqual([]) // fresh and pending is normal
      expect(mineOnly(NOW + 11 * MIN)).toMatchObject([{ user_id: 'rider-1', id: 'r1:trip:driver_assigned', code: 'undelivered', detail: 'push pending' }])
      pushResult('failed'); pushResult('failed', NOW + 30_000); pushResult('failed', NOW + 150_000, 'd1', 'no subscription')
      const codes = (mineOnly(NOW + 160_000) as unknown as { code: string }[]).map((i) => i.code)
      expect(codes).toEqual(['push_failed'])
      emailResult('failed', NOW + 160_000, 'd1', 'smtp'); emailResult('failed', NOW + 200_000); emailResult('failed', NOW + 400_000)
      expect((mineOnly(NOW + 500_000) as unknown as { code: string }[]).map((i) => i.code).sort()).toEqual(['email_failed', 'push_failed'])
      expect(JSON.stringify(as('ops', 'ops_list_notification_issues', {}, NOW + 500_000))).not.toContain('Driver d1')
    })
  })
})

describe('operations console', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const MIN = 60_000
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }
  const AIRPORT = { lat: -33.8688 + 0.045, lng: 151.2093 } // ~5 km north

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db, new Set())
  })

  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)
  const makeDriver = (id: string) => {
    as(id, 'save_driver_application', { full_name: `Driver ${id}`, phone: '555-0100', licence_number: `LIC-${id}`, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: `PL-${id}`, make: 'T', model: 'C', vehicle_class: 'share' })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
    as(id, 'update_driver_location', { ...SYDNEY, service_radius_km: 10 })
    as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })
  }
  const matched = (id = 'r1', rider = 'rider-1', driver = 'd1') => {
    if (!db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(driver)) makeDriver(driver)
    db.prepare('UPDATE driver_availability SET available = CASE WHEN user_id = ? THEN 1 ELSE 0 END').run(driver)
    as(rider, 'save_ride', { ...rideToRecords({ id, pickup: '12 Secret Lane', pickupCoord: SYDNEY, dropoff: '1 Airport Rd', dropoffCoord: AIRPORT, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1500 }) })
    as(rider, 'save_rider_profile', { display_name: 'Rita Rider', phone: '555-0199', notify_email: 0, notify_sms: 0, notify_trip_updates: 1 })
    as(rider, 'request_dispatch', { request_id: id })
    as(rider, 'dispatch_tick', { request_id: id })
    as(driver, 'accept_offer', { rider_id: rider, request_id: id })
  }
  const trip = (id = 'r1', rider = 'rider-1') => ({ rider_id: rider, trip_id: `${id}:trip` })
  const step = (to: string, driver = 'd1', id = 'r1', rider = 'rider-1', now = NOW) => as(driver, 'advance_trip', { ...trip(id, rider), to_status: to }, now)
  const ping = (driver = 'd1', at = NOW, pos = SYDNEY, id = 'r1', rider = 'rider-1') => as(driver, 'publish_driver_location', { ...trip(id, rider), ...pos, accuracy_m: 8 }, at)
  const complete = () => {
    step('en_route'); ping('d1', NOW)
    step('arrived', 'd1', 'r1', 'rider-1', NOW + 1000)
    as('d1', 'start_trip', trip(), NOW + 2000)
    ping('d1', NOW + 5000, AIRPORT)
    step('completed', 'd1', 'r1', 'rider-1', NOW + 6000)
  }
  /** The staff trail after setup (drivers are approved at NOW in the helpers). */
  const trail = (extra: Record<string, unknown> = {}) => (as('ops', 'ops_list_audit', extra) as Record<string, unknown>[]).filter((a) => (a.at as number) > NOW)
  const search = (params: Record<string, unknown> = {}, who = 'ops') => as(who, 'ops_search_trips', params) as Record<string, unknown>[]

  describe('roles', () => {
    it('every ops tool is role-gated; PII tools need ops_pii', () => {
      const gated = (mcpFile.tools as unknown as { name: string; auth?: { app_roles: string[] } }[]).filter((t) => t.name.startsWith('ops_'))
      expect(gated.length).toBeGreaterThan(15)
      for (const t of gated) expect(t.auth, t.name).toBeDefined()
      for (const name of ['ops_log_access', 'ops_get_trip_pii', 'ops_get_trip_evidence_pii', 'get_driver_application_detail'])
        expect(tool(name), name).toMatchObject({ auth: { required: true, app_roles: ['ops_pii'] } })
      for (const name of ['ops_search_trips', 'ops_get_trip', 'ops_get_trip_offers', 'ops_get_trip_evidence', 'ops_cancel_trip', 'ops_suspend_driver', 'ops_reinstate_driver', 'ops_request_refund', 'ops_decide_refund', 'ops_escalate', 'ops_resolve_escalation', 'ops_list_audit'])
        expect(tool(name), name).toMatchObject({ auth: { required: true, app_roles: ['ops'] } })
    })

    it('rider and driver actions are never role-gated', () => {
      for (const name of ['cancel_ride', 'advance_trip', 'start_trip', 'open_dispute', 'get_receipt']) expect((tool(name) as unknown as { auth?: unknown }).auth, name).toBeUndefined()
    })
  })

  describe('search and inspect', () => {
    it('finds trips by trip id, ride id, rider, driver or receipt number — exact matches only', () => {
      matched(); complete()
      matched('r2', 'rider-2', 'd2')
      const receipt = (db.prepare('SELECT receipt_no FROM fare_statements').get() as { receipt_no: string }).receipt_no
      for (const q of ['r1:trip', 'r1', 'rider-1', 'd1', receipt]) expect(search({ q }).map((r) => r.trip_id), q).toEqual(['r1:trip'])
      expect(search({ q: 'rider' })).toEqual([]) // no partial matching
      expect(search({ q: 'nobody' })).toEqual([])
      expect(search().map((r) => r.trip_id).sort()).toEqual(['r1:trip', 'r2:trip'])
    })

    it('filters by status and shows phase, outcome, amounts and dispatch state', () => {
      matched(); complete()
      matched('r2', 'rider-2', 'd2')
      expect(search({ status: 'completed' })).toMatchObject([{ trip_id: 'r1:trip', phase: 'completed', outcome: 'completed', final_cents: 1500, dispatch_status: 'matched', driver_user_id: 'd1', vehicle_class: 'share', dispute_open: 0 }])
      expect(search({ status: 'scheduled' })).toMatchObject([{ trip_id: 'r2:trip', phase: 'scheduled', outcome: null }])
    })

    it('shows an in-progress phase and an open dispute', () => {
      matched(); step('en_route'); step('arrived'); as('d1', 'start_trip', trip())
      expect(search({ q: 'r1' })).toMatchObject([{ phase: 'in_progress' }])
      step('completed')
      as('rider-1', 'open_dispute', { ...trip(), reason_code: 'overcharged' }, NOW + 1000)
      expect(search({ q: 'r1' })).toMatchObject([{ phase: 'completed', dispute_open: 1 }])
    })

    it('redacts personal details everywhere in the basic views', () => {
      matched(); complete()
      const everything = JSON.stringify([search(), as('ops', 'ops_get_trip', trip()), as('ops', 'ops_get_trip_offers', { rider_id: 'rider-1', request_id: 'r1' }), as('ops', 'ops_get_trip_evidence', trip()), as('ops', 'ops_get_trip_timeline', trip())])
      for (const secret of ['12 Secret Lane', '1 Airport Rd', 'Rita Rider', 'Driver d1', 'PL-d1', '555-0199', 'LIC-d1', String(SYDNEY.lat), String(SYDNEY.lng)]) expect(everything, secret).not.toContain(secret)
    })

    it('inspects a trip: lifecycle, fees, assignment and dispatch, counts', () => {
      matched()
      as('rider-1', 'cancel_ride', { request_id: 'r1', reason_code: 'wrong_pickup' }, NOW + 3 * MIN)
      expect(as('ops', 'ops_get_trip', trip())).toMatchObject([{ trip_id: 'r1:trip', phase: 'cancelled', outcome: 'rider_cancelled', cancelled_by_role: 'rider', cancel_code: 'wrong_pickup', cancel_fee_cents: 500, fee_policy: 'late_cancel', assignment_status: 'accepted', dispatch_status: 'cancelled', dispatch_attempts: 1, final_cents: 500, disputes: 0, refund_requests: 0 }])
    })

    it('shows the dispatch chain with each driver offered and what happened', () => {
      matched()
      expect(as('ops', 'ops_get_trip_offers', { rider_id: 'rider-1', request_id: 'r1' })).toMatchObject([{ attempt: 1, driver_user_id: 'd1', status: 'accepted' }])
    })

    it('hides trips the staff member took part in', () => {
      matched()
      expect(search({}, 'rider-1')).toEqual([])
      expect(search({}, 'd1')).toEqual([])
      expect(as('rider-1', 'ops_get_trip', trip())).toEqual([])
      expect(as('d1', 'ops_get_trip', trip())).toEqual([])
      expect(as('d1', 'ops_get_trip_evidence', trip())).toEqual([])
    })
  })

  describe('location evidence', () => {
    it('keeps coarse snapshots when the driver arrives, the trip starts and it ends, while the live position is still deleted', () => {
      matched(); complete()
      expect(db.prepare('SELECT kind FROM trip_evidence ORDER BY captured_at').all()).toEqual([{ kind: 'arrived' }, { kind: 'started' }, { kind: 'ended' }])
      expect(count(db, 'trip_locations')).toBe(0) // the retention rule from #8 is unchanged
    })

    it('records a snapshot on a no-show cancellation too', () => {
      matched(); step('en_route'); ping('d1', NOW); step('arrived', 'd1', 'r1', 'rider-1', NOW + 1000); ping('d1', NOW + 4000)
      as('d1', 'report_rider_no_show', trip(), NOW + 6 * MIN)
      expect(db.prepare('SELECT kind FROM trip_evidence ORDER BY captured_at').all()).toEqual([{ kind: 'arrived' }])
    })

    it('records an ended snapshot when a fresh position exists at the end', () => {
      matched(); step('en_route'); ping('d1', NOW); step('arrived', 'd1', 'r1', 'rider-1', NOW + 1000)
      ping('d1', NOW + 5 * MIN)
      as('d1', 'report_rider_no_show', trip(), NOW + 5 * MIN + 5000)
      expect(db.prepare('SELECT kind FROM trip_evidence ORDER BY captured_at').all()).toEqual([{ kind: 'arrived' }, { kind: 'ended' }])
    })

    it('takes no snapshot from a stale position', () => {
      matched(); step('en_route'); ping('d1', NOW)
      step('arrived', 'd1', 'r1', 'rider-1', NOW + 61_000) // the last ping is 61 s old
      expect(count(db, 'trip_evidence')).toBe(0)
    })

    it('tells ops how close the driver was, without coordinates', () => {
      matched(); complete()
      const evidence = as('ops', 'ops_get_trip_evidence', trip()) as { kind: string; proximity: string }[]
      expect(evidence.map((e) => [e.kind, e.proximity])).toEqual([['arrived', 'within_150m'], ['started', 'within_150m'], ['ended', 'within_150m']])
      expect(JSON.stringify(evidence)).not.toMatch(/"lat"|"lng"/)
    })

    it('flags a driver who was nowhere near the pickup', () => {
      matched(); step('en_route'); ping('d1', NOW, AIRPORT)
      step('arrived', 'd1', 'r1', 'rider-1', NOW + 1000)
      expect(as('ops', 'ops_get_trip_evidence', trip())).toMatchObject([{ kind: 'arrived', proximity: 'farther' }])
    })

    it('buckets distance: within 500 m and within 2 km', () => {
      for (const [km, expected] of [[0.3, 'within_500m'], [1.2, 'within_2km']] as const) {
        db = new DatabaseSync(':memory:'); migrate(db, new Set())
        matched(); step('en_route'); ping('d1', NOW, { lat: SYDNEY.lat + km * 0.009, lng: SYDNEY.lng })
        step('arrived', 'd1', 'r1', 'rider-1', NOW + 1000)
        expect(as('ops', 'ops_get_trip_evidence', trip())).toMatchObject([{ proximity: expected }])
      }
    })

    it('is deleted after 30 days on the next location publish, and with the rider\'s account', () => {
      matched(); complete()
      matched('r2', 'rider-2', 'd2')
      const later = NOW + 31 * 24 * 60 * MIN
      as('d2', 'advance_trip', { ...trip('r2', 'rider-2'), to_status: 'en_route' }, later)
      ping('d2', later, SYDNEY, 'r2', 'rider-2')
      expect(count(db, 'trip_evidence')).toBe(0)
      db = new DatabaseSync(':memory:'); migrate(db, new Set())
      matched(); complete()
      expect(count(db, 'trip_evidence')).toBe(3)
      as('rider-1', 'delete_my_rider_data')
      expect(count(db, 'trip_evidence')).toBe(0)
    })

    it('exact coordinates need ops_pii and a logged reason, and the access expires', () => {
      matched(); complete()
      const read = (who: string, now: number) => as(who, 'ops_get_trip_evidence_pii', trip(), now) as { kind: string; lat: number }[]
      expect(read('pii-1', NOW + 10_000)).toEqual([]) // never logged a reason
      as('pii-1', 'ops_log_access', { scope: 'evidence', ...trip(), reason_code: 'dispute' }, NOW + 7000)
      expect(read('pii-1', NOW + 7500).map((e) => e.kind)).toEqual(['arrived', 'started', 'ended'])
      expect(read('pii-1', NOW + 7500)[0].lat).toBeCloseTo(SYDNEY.lat, 3)
      expect(read('pii-2', NOW + 7500)).toEqual([]) // someone else's reason does not count
      expect(as('pii-1', 'ops_get_trip_pii', trip(), NOW + 7500)).toEqual([]) // the scope was evidence, not trip_pii
      expect(read('pii-1', NOW + 7000 + 10 * MIN + 1)).toEqual([])
    })
  })

  describe('personal data access', () => {
    const logAccess = (who = 'pii-1', extra: Record<string, unknown> = {}, now = NOW) => as(who, 'ops_log_access', { scope: 'trip_pii', ...trip(), reason_code: 'support_ticket', ...extra }, now)

    it('returns addresses, names and plate only after a logged reason', () => {
      matched(); complete()
      expect(as('pii-1', 'ops_get_trip_pii', trip())).toEqual([])
      logAccess()
      expect(as('pii-1', 'ops_get_trip_pii', trip())).toEqual([{ trip_id: 'r1:trip', pickup_label: '12 Secret Lane', dropoff_label: '1 Airport Rd', rider_name: 'Rita Rider', driver_name: 'Driver d1', plate: 'PL-d1' }])
    })

    it('requires a valid reason and scope, and never for trips the staff member took part in', () => {
      matched()
      logAccess('pii-1', { reason_code: 'curiosity' })
      logAccess('pii-1', { scope: 'everything' })
      logAccess('pii-1', { trip_id: 'ghost:trip' })
      logAccess('rider-1')
      logAccess('d1')
      logAccess('pii-1', { scope: 'driver_pii', driver_user_id: 'pii-1', rider_id: undefined, trip_id: undefined })
      expect(count(db, 'ops_access_log')).toBe(0)
      logAccess('pii-1', { reason_code: 'legal_request' })
      expect(db.prepare('SELECT actor_id, scope, reason_code, rider_id, trip_id, at FROM ops_access_log').all()).toEqual([{ actor_id: 'pii-1', scope: 'trip_pii', reason_code: 'legal_request', rider_id: 'rider-1', trip_id: 'r1:trip', at: NOW }])
    })

    it('every access appears in the audit trail', () => {
      matched()
      logAccess('pii-1', {}, NOW + 3)
      expect(trail()).toMatchObject([{ action: 'pii_access_trip_pii', actor_id: 'pii-1', trip_id: 'r1:trip', reason_code: 'support_ticket', at: NOW + 3 }])
    })
  })

  describe('support actions need reason codes and are audited', () => {
    const audit = trail

    it('cancels with a valid reason code, note and fee, and records all three', () => {
      matched(); step('en_route')
      const attempt = (bad: Record<string, unknown>) => { try { as('ops', 'ops_cancel_trip', { ...trip(), reason_code: 'other', note: 'x', fee_cents: 0, ...bad }) } catch { /* a missing required parameter is also a refusal */ } }
      attempt({ reason_code: 'whim' }); attempt({ reason_code: undefined }); attempt({ note: ' ' })
      expect(db.prepare('SELECT status FROM trips').get()).toEqual({ status: 'en_route' })
      as('ops', 'ops_cancel_trip', { ...trip(), reason_code: 'vehicle_issue', note: 'tow truck called', fee_cents: 0 }, NOW + 1)
      expect(db.prepare('SELECT status FROM trips').get()).toEqual({ status: 'cancelled' })
      expect(db.prepare('SELECT cancel_code, cancel_note, cancelled_by_role FROM trip_lifecycle').get()).toEqual({ cancel_code: 'vehicle_issue', cancel_note: 'tow truck called', cancelled_by_role: 'ops' })
      expect(audit()).toMatchObject([{ action: 'trip_cancelled', actor_id: 'ops', trip_id: 'r1:trip', reason_code: 'vehicle_issue', note: 'tow truck called', at: NOW + 1 }])
    })

    it('suspends a driver only with a reason code and note, and the driver goes off dispatch', () => {
      makeDriver('d1')
      const suspend = (extra: Record<string, unknown>) => as('ops', 'ops_suspend_driver', { driver_user_id: 'd1', reason_code: 'safety', note: 'two complaints', ...extra }, NOW + 5)
      suspend({ reason_code: 'because' }); suspend({ note: '  ' }); suspend({ driver_user_id: 'ghost' })
      as('ops', 'review_driver_application', { driver_user_id: 'd1', decision: 'suspended', reason: 'no code' }) // the old route is closed
      expect(db.prepare('SELECT status FROM driver_applications').get()).toEqual({ status: 'approved' })
      suspend({})
      expect(db.prepare('SELECT status, status_reason, reviewed_by FROM driver_applications').get()).toEqual({ status: 'suspended', status_reason: 'safety: two complaints', reviewed_by: 'ops' })
      expect(as('ops', 'list_dispatchable_drivers')).toEqual([])
      expect(db.prepare('SELECT available FROM driver_availability').get()).toEqual({ available: 0 })
      expect(audit()).toMatchObject([{ action: 'driver_suspended', actor_id: 'ops', driver_user_id: 'd1', note: 'safety: two complaints', at: NOW + 5 }])
      suspend({}) // repeating changes nothing
      expect(audit().filter((a) => a.action === 'driver_suspended')).toHaveLength(1)
    })

    it('withdraws an offer that was open to the suspended driver', () => {
      makeDriver('d1')
      as('rider-1', 'save_ride', { ...rideToRecords({ id: 'r1', pickup: 'A', pickupCoord: SYDNEY, dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1500 }) })
      as('rider-1', 'request_dispatch', { request_id: 'r1' }); as('rider-1', 'dispatch_tick', { request_id: 'r1' })
      expect(as('d1', 'list_my_offers')).toHaveLength(1)
      as('ops', 'ops_suspend_driver', { driver_user_id: 'd1', reason_code: 'fraud_suspected', note: 'checking' })
      expect(as('d1', 'list_my_offers')).toEqual([])
    })

    it('reinstates with a reason code; the driver must opt in again; staff cannot lift their own suspension', () => {
      makeDriver('d1')
      as('ops', 'ops_suspend_driver', { driver_user_id: 'd1', reason_code: 'complaint', note: 'x' }, NOW + 5)
      as('ops', 'ops_reinstate_driver', { driver_user_id: 'd1', reason_code: 'nope', note: 'ok' })
      as('ops', 'ops_reinstate_driver', { driver_user_id: 'd1', reason_code: 'review_complete', note: ' ' })
      as('d1', 'ops_reinstate_driver', { driver_user_id: 'd1', reason_code: 'error', note: 'self' })
      expect(db.prepare('SELECT status FROM driver_applications').get()).toEqual({ status: 'suspended' })
      as('ops', 'ops_reinstate_driver', { driver_user_id: 'd1', reason_code: 'review_complete', note: 'cleared by safety team' }, NOW + 9)
      expect(db.prepare('SELECT status, status_reason FROM driver_applications').get()).toEqual({ status: 'approved', status_reason: null })
      expect(as('ops', 'list_dispatchable_drivers')).toEqual([]) // still offline until they opt in
      expect(audit().map((a) => a.action)).toEqual(['driver_approved', 'driver_suspended'])
      expect(audit()[0]).toMatchObject({ note: 'review_complete: cleared by safety team', at: NOW + 9 })
    })

    it('cannot suspend yourself', () => {
      makeDriver('ops-driver')
      as('ops-driver', 'ops_suspend_driver', { driver_user_id: 'ops-driver', reason_code: 'safety', note: 'x' })
      expect(db.prepare('SELECT status FROM driver_applications').get()).toEqual({ status: 'approved' })
    })

    it('records a credit with its actor and reason in the same trail', () => {
      matched(); complete()
      as('ops', 'ops_credit_trip', { ...trip(), request_key: 'k', amount_cents: 200, reason_code: 'goodwill', note: 'late pickup' }, NOW + 20_000)
      expect(audit({ trip_id: 'r1:trip' }).find((a) => a.action === 'credit')).toMatchObject({ actor_id: 'ops', reason_code: 'goodwill', amount_cents: 200, at: NOW + 20_000 })
    })

    it('records dispute decisions and the fee waiver', () => {
      matched(); as('rider-1', 'cancel_ride', { request_id: 'r1' }, NOW + 3 * MIN)
      as('rider-1', 'open_dispute', { ...trip(), reason_code: 'cancel_fee' }, NOW + 4 * MIN)
      as('ops', 'ops_resolve_dispute', { ...trip(), opened_by: 'rider-1', decision: 'upheld', note: 'driver late', waive_fee: 1 }, NOW + 5 * MIN)
      expect(audit({ trip_id: 'r1:trip' }).map((a) => a.action)).toEqual(expect.arrayContaining(['fee_waived', 'dispute_resolved', 'credit']))
    })

    it('filters the trail by trip and by actor, newest first, and omits riders\' and drivers\' own actions', () => {
      matched(); complete()
      matched('r2', 'rider-2', 'd2')
      as('ops', 'ops_cancel_trip', { ...trip('r2', 'rider-2'), reason_code: 'other', note: 'dup', fee_cents: 0 }, NOW + 100)
      as('ops-2', 'ops_escalate', { request_key: 'e1', ...trip('r1'), level: 'lead', reason_code: 'safety', note: 'look' }, NOW + 200)
      expect(audit({ trip_id: 'r2:trip' }).map((a) => a.action)).toEqual(['trip_cancelled'])
      expect(audit({ actor: 'ops-2' }).map((a) => a.action)).toEqual(['escalated_lead'])
      const all = audit()
      expect(all.map((a) => a.at)).toEqual([...all.map((a) => a.at as number)].sort((x, y) => y - x))
      expect(all.every((a) => ['ops', 'ops-2'].includes(a.actor_id as string))).toBe(true)
    })
  })

  describe('refund requests', () => {
    const request = (extra: Record<string, unknown> = {}, who = 'ops') => as(who, 'ops_request_refund', { ...trip(), request_key: 'k1', amount_cents: 600, reason_code: 'overcharged', note: 'meter ran long', ...extra })
    const rows = () => db.prepare('SELECT id, amount_cents, reason_code, status, requested_by, decided_by FROM refund_requests').all()

    it('records a request with reason, note, amount and requester, but moves no money', () => {
      matched(); complete()
      request()
      expect(rows()).toEqual([{ id: 'k1', amount_cents: 600, reason_code: 'overcharged', status: 'requested', requested_by: 'ops', decided_by: null }])
      expect(count(db, 'fare_adjustments')).toBe(0)
      expect(as('rider-1', 'get_receipt', { request_id: 'r1' })).toMatchObject([{ total_cents: 1500 }])
    })

    it('rejects bad input, over-asking, and repeats of a key', () => {
      matched(); complete()
      request({ reason_code: 'greed' }); request({ note: ' ' }); request({ amount_cents: 0 }); request({ request_key: ' ' }); request({ trip_id: 'ghost' })
      request({ amount_cents: 1501 })
      expect(rows()).toEqual([])
      request({ amount_cents: 1000 })
      request({ amount_cents: 1000 }) // same key: ignored
      request({ request_key: 'k2', amount_cents: 501 }) // only 500 left after the open request
      expect(rows()).toHaveLength(1)
      request({ request_key: 'k3', amount_cents: 500 })
      expect(rows()).toHaveLength(2)
    })

    it('counts credits against the amount that can be requested', () => {
      matched(); complete()
      as('ops', 'ops_credit_trip', { ...trip(), request_key: 'c', amount_cents: 1000, reason_code: 'goodwill', note: 'x' })
      request({ amount_cents: 501 })
      expect(rows()).toEqual([])
      request({ amount_cents: 500 })
      expect(rows()).toHaveLength(1)
    })

    it('needs a second person to decide, who is not the requester or a participant', () => {
      matched(); complete()
      request()
      const decide = (who: string, extra: Record<string, unknown> = {}) => as(who, 'ops_decide_refund', { rider_id: 'rider-1', request_key: 'k1', decision: 'approved', note: 'checked the meter', ...extra }, NOW + 1)
      decide('ops') // the requester
      decide('rider-1'); decide('d1') // participants
      decide('ops-2', { note: ' ' }); decide('ops-2', { decision: 'maybe' })
      expect(rows()[0]).toMatchObject({ status: 'requested', decided_by: null })
      decide('ops-2')
      expect(rows()[0]).toMatchObject({ status: 'approved', decided_by: 'ops-2' })
      decide('ops-3', { decision: 'rejected' }) // already decided
      expect(rows()[0]).toMatchObject({ status: 'approved', decided_by: 'ops-2' })
      expect(count(db, 'fare_adjustments')).toBe(0) // approval records the decision only
    })

    it('lists requests by status and puts both steps in the audit trail', () => {
      matched(); complete()
      request()
      expect(as('ops-2', 'ops_list_refund_requests')).toMatchObject([{ request_key: 'k1', status: 'requested', amount_cents: 600, requested_by: 'ops' }])
      as('ops-2', 'ops_decide_refund', { rider_id: 'rider-1', request_key: 'k1', decision: 'rejected', note: 'within tolerance' }, NOW + 5)
      expect(as('ops-2', 'ops_list_refund_requests')).toEqual([])
      expect(as('ops-2', 'ops_list_refund_requests', { status: 'rejected' })).toMatchObject([{ decision_note: 'within tolerance', decided_by: 'ops-2' }])
      expect(trail().map((a) => a.action)).toEqual(['refund_rejected'])
      expect((as('ops', 'ops_list_audit', { trip_id: 'r1:trip' }) as { action: string }[]).map((a) => a.action)).toEqual(['refund_rejected', 'refund_requested'])
    })

    it('is erased with the rider\'s account', () => {
      matched(); complete(); request()
      as('rider-1', 'delete_my_rider_data')
      expect(rows()).toEqual([])
    })

    it('cannot be requested on a trip the staff member rode or drove', () => {
      matched(); complete()
      request({}, 'rider-1'); request({}, 'd1')
      expect(rows()).toEqual([])
    })
  })

  describe('escalations', () => {
    const escalate = (extra: Record<string, unknown> = {}, who = 'ops') => as(who, 'ops_escalate', { request_key: 'e1', ...trip(), level: 'safety', reason_code: 'safety', note: 'driver reported an incident', ...extra })
    const rows = () => db.prepare('SELECT id, rider_id, trip_id, driver_user_id, level, reason_code, status, opened_by, resolved_by FROM ops_escalations ORDER BY id').all()

    it('escalates a trip or a driver with a level, reason code and note', () => {
      matched()
      escalate()
      escalate({ request_key: 'e2', rider_id: undefined, trip_id: undefined, driver_user_id: 'd1', level: 'lead', reason_code: 'abuse' })
      expect(rows()).toEqual([
        { id: 'e1', rider_id: 'rider-1', trip_id: 'r1:trip', driver_user_id: null, level: 'safety', reason_code: 'safety', status: 'open', opened_by: 'ops', resolved_by: null },
        { id: 'e2', rider_id: null, trip_id: null, driver_user_id: 'd1', level: 'lead', reason_code: 'abuse', status: 'open', opened_by: 'ops', resolved_by: null },
      ])
    })

    it('rejects unknown levels and codes, blank notes and keys, nothing to escalate, and unknown targets', () => {
      matched()
      escalate({ level: 'president' }); escalate({ reason_code: 'boredom' }); escalate({ note: ' ' }); escalate({ request_key: ' ' })
      escalate({ rider_id: undefined, trip_id: undefined, driver_user_id: undefined }) // no target
      escalate({ trip_id: 'ghost:trip' }); escalate({ rider_id: undefined, trip_id: undefined, driver_user_id: 'ghost' })
      expect(rows()).toEqual([])
      escalate(); escalate() // repeating a key is a no-op
      expect(rows()).toHaveLength(1)
    })

    it('another person resolves it, with a note, once', () => {
      matched()
      escalate()
      const resolve = (who: string, note = 'safety team called the driver') => as(who, 'ops_resolve_escalation', { request_key: 'e1', note }, NOW + 9)
      resolve('ops'); resolve('ops-2', ' ')
      expect(rows()[0]).toMatchObject({ status: 'open' })
      expect(as('ops-2', 'ops_list_escalations')).toHaveLength(1)
      resolve('ops-2')
      expect(rows()[0]).toMatchObject({ status: 'resolved', resolved_by: 'ops-2' })
      resolve('ops-3', 'again')
      expect(db.prepare('SELECT resolved_by, resolution_note FROM ops_escalations').get()).toEqual({ resolved_by: 'ops-2', resolution_note: 'safety team called the driver' })
      expect(as('ops-2', 'ops_list_escalations')).toEqual([])
      expect(as('ops-2', 'ops_list_escalations', { status: 'resolved' })).toHaveLength(1)
      expect((as('ops', 'ops_list_audit', { trip_id: 'r1:trip' }) as { action: string }[]).map((a) => a.action)).toEqual(['escalation_resolved', 'escalated_safety'])
    })
  })
})
