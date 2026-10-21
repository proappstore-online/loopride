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
    advance('driver-1', 'completed', undefined, 'user-a', 3_000)
    advance('driver-1', 'en_route', undefined, 'user-a', 4_000) // terminal — no-op
    expect(tripStatus()).toBe('completed')
    expect(history().slice(1)).toEqual([
      { from_status: 'en_route', to_status: 'arrived', actor_type: 'driver', actor_id: 'driver-1', metadata: '{"lat":-33.86}', at: 2_000 },
      { from_status: 'arrived', to_status: 'completed', actor_type: 'driver', actor_id: 'driver-1', metadata: null, at: 3_000 },
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
    advance('driver-1', 'cancelled', '{"reason":"vehicle fault"}')
    expect(tripStatus()).toBe('cancelled')
    expect(db.prepare('SELECT status FROM ride_requests').get()).toEqual({ status: 'cancelled' })
    expect(history()[1]).toMatchObject({ to_status: 'cancelled', actor_type: 'driver', metadata: '{"reason":"vehicle fault"}' })
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
    call(db, 'delete_my_rider_data', {}, 'driver-1')
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
    const opsTools = ['list_driver_applications', 'get_driver_application_detail', 'list_driver_vehicles_for_review', 'list_driver_review_log', 'review_driver_application', 'review_driver_vehicle', 'list_dispatchable_drivers']
    for (const name of opsTools) expect(tool(name), name).toMatchObject({ auth: { required: true, app_roles: ['ops'] } })
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

  it('ops list masks the licence number; detail shows it', () => {
    submitted()
    const [row] = as('ops-1', 'list_driver_applications', { status: 'submitted' }) as Record<string, unknown>[]
    expect(row).toMatchObject({ user_id: 'drv', licence_last4: '4567', vehicle_count: 1 })
    expect(JSON.stringify(row)).not.toContain('D1234567')
    expect(as('ops-1', 'get_driver_application_detail', { driver_user_id: 'drv' })).toMatchObject([{ licence_number: 'D1234567' }])
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
    review('suspended', 'too early') // submitted cannot be suspended
    expect(appStatus()).toBe('submitted')
    review('approved')
    review('rejected', 'late') // approved cannot be rejected
    expect(appStatus()).toBe('approved')
    review('banana', 'x')
    expect(appStatus()).toBe('approved')
    review('suspended', 'complaint')
    expect(appStatus()).toBe('suspended')
    review('approved')
    expect(appStatus()).toBe('approved') // reinstated
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
    review('suspended', 'safety report')
    expect(dispatchable()).toEqual([])
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 0 }])
    goAvailable() // suspended drivers cannot return themselves
    expect(as('drv', 'get_my_driver_availability')).toMatchObject([{ available: 0 }])
    review('approved') // reinstated, but must opt in again
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
