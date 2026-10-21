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
    as('ops', 'review_driver_application', { driver_user_id: 'susp', decision: 'suspended', reason: 'complaint' })
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
    as('ops', 'review_driver_application', { driver_user_id: 'd2', decision: 'suspended', reason: 'safety' })
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
    as('ops-rider', 'ops_cancel_trip', { ...trip('r1:trip', 'ops-rider'), note: 'x' }) // the rider is the ops user
    expect(status()).toBe('scheduled')
    as('d1', 'ops_cancel_trip', { ...trip('r1:trip', 'ops-rider'), note: 'x' }) // the driver is the ops user
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
      as('ops', 'ops_cancel_trip', { ...trip(), note: '  ' }, NOW + 1) // blank note
      expect(status()).toBe('arrived')
      as('ops', 'ops_cancel_trip', { ...trip(), note: 'safety incident', fee_cents: 99_999 }, NOW + 2)
      expect(status()).toBe('cancelled')
      expect(life()).toMatchObject({ outcome: 'ops_cancelled', cancelled_by_role: 'ops', cancel_fee_cents: 1500, fee_policy: 'ops_set' })
      expect(events().at(-1)).toEqual({ event: 'cancelled', actor_role: 'ops', reason_code: 'ops_cancelled', note: 'safety incident', amount_cents: 1500 })
      expect(db.prepare('SELECT status FROM dispatch_offers').get()).toEqual({ status: 'cancelled' })
    })

    it('does not touch finished trips and never charges a negative fee', () => {
      matched(); toArrived(); start(); advance('completed')
      as('ops', 'ops_cancel_trip', { ...trip(), note: 'late' })
      expect(status()).toBe('completed')
      db = new DatabaseSync(':memory:'); migrate(db, new Set())
      matched()
      as('ops', 'ops_cancel_trip', { ...trip(), note: 'dup', fee_cents: -50 })
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
    ['ops cancellation', () => as('ops', 'ops_cancel_trip', { ...trip, note: 'incident' })],
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
    as('d1', 'delete_my_rider_data')
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
