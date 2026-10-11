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
  const bound: Record<string, unknown> = { __user_id: userId, __now: now }
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
