// @vitest-environment node
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import migrationsFile from '../../../migrations.json'
import mcpFile from '../../../mcp.json'
import { DATA_CLASSES } from './privacyInventory'
import { rideToRecords } from './rideRecords'

// Issue #13. Runs the committed migrations.json + mcp.json against real SQLite, the same way
// domainSchema.test.ts does, but WITHOUT its shortcut of treating every driver as having agreed to
// location sharing: consent, retention, export and erasure are what is under test here.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

interface ParamSpec { type: string; optional?: boolean; default?: unknown }
interface Tool {
  name: string
  operation: 'query' | 'execute' | 'batch'
  sql?: string
  statements?: string[]
  params?: Record<string, ParamSpec>
  requires_auth: boolean
  auth?: { required: boolean; app_roles?: string[] }
}
type Db = InstanceType<typeof DatabaseSync>

const tools = mcpFile.tools as unknown as Tool[]
const tool = (name: string) => tools.find((t) => t.name === name)!
const statementsOf = (t: Tool) => t.statements ?? [t.sql!]
const sqlOf = (name: string) => statementsOf(tool(name)).join('\n')
const placeholders = (sql: string) => [...sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1])

function migrate(db: Db) {
  for (const m of migrationsFile.migrations) db.exec(m.sql)
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
    } else bound[key] = value
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

const ROOT = join(__dirname, '..', '..', '..')
const privacyDoc = readFileSync(join(ROOT, 'docs', 'privacy.md'), 'utf8')
const dbClasses = DATA_CLASSES.filter((c) => !c.id.includes(':'))
const tablesIn = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name)

describe('privacy inventory matches the schema and the actions', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)

  it('has an entry for every table, and no entry for a table that does not exist', () => {
    expect(dbClasses.map((c) => c.id).sort()).toEqual(tablesIn(db).sort())
  })

  it('has no duplicate entries', () => {
    const ids = DATA_CLASSES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every table that is erased is deleted by the action the inventory names, and audit tables are deleted by none', () => {
    const everyDelete = ['delete_my_rider_data', 'delete_my_driver_data'].map(sqlOf).join('\n')
    for (const c of dbClasses) {
      if (c.erasedBy === 'kept_for_audit') expect(everyDelete, c.id).not.toMatch(new RegExp(`DELETE FROM ${c.id}\\b`))
      else expect(sqlOf(c.erasedBy), c.id).toMatch(new RegExp(`DELETE FROM ${c.id}\\b`))
    }
  })

  it('every table is exported by a real action, or says why not', () => {
    for (const c of DATA_CLASSES) {
      if (typeof c.exportedBy !== 'string') {
        expect(c.exportedBy.none.length, c.id).toBeGreaterThan(20)
        continue
      }
      if (c.id.includes(':')) continue // device and key-value stores are exported by the app, not an action
      const [action, section] = c.exportedBy.split(':')
      expect(tool(action), `${c.id} -> ${action}`).toBeDefined()
      expect(tool(action).operation).toBe('query')
      if (section) expect(sqlOf(action), `${c.id} -> ${c.exportedBy}`).toContain(`'${section}' AS section`)
      else expect(sqlOf(action), `${c.id} -> ${action}`).toMatch(new RegExp(`FROM ${c.id}\\b`))
    }
  })

  it('every expiry window the inventory states is what purge_expired_data deletes', () => {
    const purge = tool('purge_expired_data').statements!
    for (const c of DATA_CLASSES) {
      if (c.retention.rule !== 'ttl') continue
      const stmt = purge.find((s) => new RegExp(`^DELETE FROM ${c.id}\\b`).test(s))
      expect(stmt, `${c.id} has no purge statement`).toBeDefined()
      expect(stmt, c.id).toContain(c.retention.window)
    }
    // ...and the purge touches nothing the inventory does not call short-lived.
    const purged = purge.map((s) => /^DELETE FROM (\w+)/.exec(s)![1]).sort()
    expect(purged).toEqual(DATA_CLASSES.filter((c) => c.retention.rule === 'ttl').map((c) => c.id).sort())
  })

  it('open legal questions are marked, explained and listed in docs/privacy.md', () => {
    const open = DATA_CLASSES.filter((c) => c.decision === 'needs-human')
    expect(open.length).toBeGreaterThan(5)
    for (const c of open) expect((c.note ?? '').length, c.id).toBeGreaterThan(20)
    for (const c of audit()) expect(c.decision, `${c.id} is kept after deletion`).toBe('needs-human')
    const needsHuman = privacyDoc.slice(privacyDoc.indexOf('## Needs a human decision'))
    expect(needsHuman.length).toBeGreaterThan(200)
    for (const c of open) expect(needsHuman, c.id).toContain(`\`${c.id}\``)
  })

  it('the inventory page names every data class', () => {
    for (const c of DATA_CLASSES) expect(privacyDoc, c.id).toContain(`\`${c.id}\``)
    expect(existsSync(join(ROOT, 'docs', 'security-review.md'))).toBe(true)
  })
})

function audit() {
  return DATA_CLASSES.filter((c) => c.erasedBy === 'kept_for_audit' && c.id !== 'service_flag_log')
}

describe('location consent', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }
  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)
  const consent = (user: string, purpose: string, granted = 1, now = NOW, version = 'v1') => as(user, 'set_location_consent', { purpose, granted, notice_version: version }, now)
  const rows = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[]
  const location = (user = 'd1') => rows(`SELECT lat, lng FROM driver_locations WHERE user_id = '${user}'`)
  const online = (user = 'd1') => rows(`SELECT available FROM driver_availability WHERE user_id = '${user}'`)

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db)
  })

  const approve = (id: string) => {
    as(id, 'save_driver_application', { full_name: id, phone: '1', licence_number: id, licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as(id, 'save_driver_vehicle', { vehicle_id: `v-${id}`, plate: id, make: 'T', model: 'C', vehicle_class: 'share' })
    as(id, 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: id, decision: 'approved' })
  }
  const publishPosition = (id = 'd1', now = NOW) => as(id, 'update_driver_location', { ...SYDNEY, service_radius_km: 10 }, now)
  const goOnline = (id = 'd1') => as(id, 'set_driver_availability', { available: 1, vehicle_id: `v-${id}` })

  it('stores no dispatch position and refuses to go available until the driver has agreed', () => {
    approve('d1')
    publishPosition()
    goOnline()
    expect(location()).toEqual([])
    expect(online()).toEqual([])
    consent('d1', 'dispatch_availability')
    publishPosition()
    goOnline()
    expect(location()).toEqual([SYDNEY])
    expect(online()).toEqual([{ available: 1 }])
  })

  it('records the notice version and times, and keeps history of the last change per purpose', () => {
    consent('d1', 'dispatch_availability', 1, NOW, '2026-10-a')
    expect(as('d1', 'get_my_location_consents')).toEqual([{ purpose: 'dispatch_availability', granted: 1, notice_version: '2026-10-a', granted_at: NOW, withdrawn_at: null, updated_at: NOW }])
    consent('d1', 'dispatch_availability', 0, NOW + 5)
    expect(as('d1', 'get_my_location_consents')).toEqual([{ purpose: 'dispatch_availability', granted: 0, notice_version: 'v1', granted_at: NOW, withdrawn_at: NOW + 5, updated_at: NOW + 5 }])
    consent('d1', 'dispatch_availability', 1, NOW + 9)
    expect(as('d1', 'get_my_location_consents')).toMatchObject([{ granted: 1, granted_at: NOW + 9, withdrawn_at: null }])
  })

  it('is per person and per purpose', () => {
    consent('d1', 'dispatch_availability')
    expect(as('d2', 'get_my_location_consents')).toEqual([])
    expect(as('d1', 'get_my_location_consents')).toHaveLength(1)
    consent('d2', 'trip_tracking')
    expect(as('d1', 'get_my_location_consents')).toMatchObject([{ purpose: 'dispatch_availability' }])
  })

  it('ignores unknown purposes, non-boolean values and a missing notice version', () => {
    consent('d1', 'marketing')
    consent('d1', 'dispatch_availability', 2)
    consent('d1', 'dispatch_availability', 1, NOW, '')
    consent('d1', 'dispatch_availability', 1, NOW, 'x'.repeat(21))
    expect(rows('SELECT * FROM location_consents')).toEqual([])
  })

  it('withdrawing dispatch consent deletes the position, goes offline, cancels open offers and blocks new writes', () => {
    approve('d1')
    consent('d1', 'dispatch_availability')
    publishPosition()
    goOnline()
    db.prepare("INSERT INTO dispatch_offers (rider_id, request_id, attempt, driver_id, status, offered_at, expires_at) VALUES ('rider-1', 'r1', 1, 'd1', 'offered', ?, ?)").run(NOW, NOW + 20_000)
    consent('d1', 'dispatch_availability', 0, NOW + 1000)
    expect(location()).toEqual([])
    expect(online()).toEqual([{ available: 0 }])
    expect(rows('SELECT status FROM dispatch_offers')).toEqual([{ status: 'cancelled' }])
    publishPosition('d1', NOW + 2000)
    goOnline()
    expect(location()).toEqual([])
    expect(online()).toEqual([{ available: 0 }])
  })

  it('withdrawing leaves other drivers, and the other purpose, alone', () => {
    for (const id of ['d1', 'd2']) { approve(id); consent(id, 'dispatch_availability'); consent(id, 'trip_tracking'); publishPosition(id) }
    db.prepare("INSERT INTO trip_locations (rider_id, trip_id, driver_id, lat, lng, updated_at) VALUES ('rider-1', 'a:trip', 'd1', 1, 1, ?), ('rider-2', 'b:trip', 'd2', 2, 2, ?)").run(NOW, NOW)
    consent('d1', 'dispatch_availability', 0, NOW + 1)
    expect(location('d2')).toHaveLength(1)
    expect(rows('SELECT driver_id FROM trip_locations ORDER BY driver_id')).toEqual([{ driver_id: 'd1' }, { driver_id: 'd2' }])
    consent('d1', 'trip_tracking', 0, NOW + 2)
    expect(rows('SELECT driver_id FROM trip_locations')).toEqual([{ driver_id: 'd2' }])
    expect(as('d1', 'get_my_location_consents')).toMatchObject([{ purpose: 'dispatch_availability', granted: 0 }, { purpose: 'trip_tracking', granted: 0 }])
  })

  it('going offline deletes the stored dispatch position', () => {
    approve('d1')
    consent('d1', 'dispatch_availability')
    publishPosition()
    goOnline()
    as('d1', 'set_driver_availability', { available: 0 })
    expect(location()).toEqual([])
    expect(online()).toEqual([{ available: 0 }])
  })

  describe('live trip tracking', () => {
    const trip = { rider_id: 'rider-1', trip_id: 'r1:trip' }
    const ping = (now = NOW) => as('d1', 'publish_driver_location', { ...trip, lat: -33.86881234, lng: 151.20931234, accuracy_m: 8 }, now)
    const stored = () => rows('SELECT lat, lng FROM trip_locations')

    beforeEach(() => {
      approve('d1')
      consent('d1', 'dispatch_availability')
      publishPosition()
      goOnline()
      as('rider-1', 'save_ride', { ...rideToRecords({ id: 'r1', pickup: 'A', pickupCoord: SYDNEY, dropoff: 'B', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1500 }) })
      as('rider-1', 'request_dispatch', { request_id: 'r1' })
      as('rider-1', 'dispatch_tick', { request_id: 'r1' })
      as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'r1' })
      as('d1', 'advance_trip', { ...trip, to_status: 'en_route' })
    })

    it('is not stored without trip_tracking consent, and dispatch consent does not stand in for it', () => {
      ping()
      expect(stored()).toEqual([])
      consent('d1', 'trip_tracking')
      ping(NOW + 4000)
      expect(stored()).toEqual([{ lat: -33.8688, lng: 151.2093 }])
    })

    it('stops being stored the moment consent is withdrawn, and what was stored is gone', () => {
      consent('d1', 'trip_tracking')
      ping()
      expect(stored()).toHaveLength(1)
      consent('d1', 'trip_tracking', 0, NOW + 1000)
      expect(stored()).toEqual([])
      ping(NOW + 9000)
      expect(stored()).toEqual([])
    })
  })
})

describe('retention', () => {
  let db: Db
  const NOW = Date.UTC(2026, 5, 1)
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  const run = (user = 'anyone', now = NOW) => call(db, 'purge_expired_data', {}, user, now)
  const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db)
  })

  const seed = (age: number) => {
    const at = NOW - age
    const tag = String(age)
    db.prepare("INSERT INTO trip_locations (rider_id, trip_id, driver_id, lat, lng, updated_at) VALUES (?, ?, 'd', 1, 1, ?)").run(`r${tag}`, `t${tag}`, at)
    db.prepare("INSERT INTO driver_locations (user_id, lat, lng, service_radius_km, updated_at) VALUES (?, 1, 1, 5, ?)").run(`d${tag}`, at)
    db.prepare("INSERT INTO trip_evidence (rider_id, trip_id, kind, lat, lng, age_ms, captured_at) VALUES (?, ?, 'arrived', 1, 1, 0, ?)").run(`r${tag}`, `t${tag}`, at)
    db.prepare("INSERT INTO notifications (user_id, id, kind, role, link, params, critical, actor_id, created_at, push_status, email_status) VALUES (?, ?, 'trip_started', 'rider', '/', '{}', 0, 'a', ?, 'sent', 'none')").run(`u${tag}`, tag, at)
    db.prepare("INSERT INTO client_events (user_id, id, at, domain, code, severity) VALUES (?, ?, ?, 'request', 'some_code', 'warn')").run(`u${tag}`, tag, at)
    db.prepare("INSERT INTO client_metrics (user_id, minute, domain, calls, errors, slow, latency_sum_ms) VALUES (?, ?, 'request', 1, 0, 0, 5)").run(`u${tag}`, Math.floor(at / 60_000))
  }
  const SHORT = ['trip_locations', 'driver_locations', 'trip_evidence', 'notifications', 'client_events', 'client_metrics']

  it('deletes each class once past its window and keeps what is inside it', () => {
    // Windows: 24h for positions; 30 days for evidence and notifications; 14 days for diagnostics.
    for (const age of [HOUR, 25 * HOUR, 13 * DAY, 15 * DAY, 29 * DAY, 31 * DAY]) seed(age)
    run()
    const remaining = (table: string, col: string) => (db.prepare(`SELECT ${col} AS k FROM ${table}`).all() as { k: string }[]).map((r) => r.k).sort()
    expect(remaining('trip_locations', 'trip_id')).toEqual([`t${HOUR}`])
    expect(remaining('driver_locations', 'user_id')).toEqual([`d${HOUR}`])
    expect(remaining('trip_evidence', 'trip_id')).toEqual([13, 15, 25, 29].map((d) => `t${d * (d === 25 ? HOUR : DAY)}`).concat(`t${HOUR}`).sort())
    expect(remaining('notifications', 'id')).toEqual([HOUR, 25 * HOUR, 13 * DAY, 15 * DAY, 29 * DAY].map(String).sort())
    expect(remaining('client_events', 'id')).toEqual([HOUR, 25 * HOUR, 13 * DAY].map(String).sort())
    expect(remaining('client_metrics', 'user_id')).toEqual([HOUR, 25 * HOUR, 13 * DAY].map((a) => `u${a}`).sort())
  })

  it('is idempotent and removes nothing else', () => {
    seed(40 * DAY)
    db.prepare("INSERT INTO riders (id, created_at, updated_at) VALUES ('old', 1, 1)").run()
    db.prepare("INSERT INTO fare_statements (rider_id, trip_id, request_id, receipt_no, basis, currency, quoted_cents, final_cents, tax_rate_bp, tax_cents, commission_bp, platform_fee_cents, driver_payout_cents, policy_version, outcome, finalized_at) VALUES ('old', 't', 'r', 'n', 'fare', 'USD', 1, 1, 0, 0, 0, 0, 1, 'v', 'completed', 1)").run()
    run(); run()
    for (const t of SHORT) expect(n(t), t).toBe(0)
    expect(n('riders')).toBe(1)
    expect(n('fare_statements')).toBe(1) // undecided, so never expired by the code
  })

  it('works for any signed-in caller and nobody else is needed to run it', () => {
    expect(tool('purge_expired_data').requires_auth).toBe(true)
    expect(tool('purge_expired_data').auth?.app_roles).toBeUndefined()
    expect(() => run('some-rider')).not.toThrow()
  })

  it('the live trip position is gone when the trip ends, however it ends', () => {
    // Existing behaviour from #8, pinned here because the retention schedule depends on it.
    for (const name of ['advance_trip', 'driver_cancel_trip', 'report_rider_no_show', 'report_driver_no_show', 'cancel_ride', 'ops_cancel_trip']) {
      expect(sqlOf(name), name).toMatch(/DELETE FROM trip_locations/)
    }
  })
})

describe('security review: authorization, personal data and abuse limits', () => {
  const NOW = Date.UTC(2026, 5, 1)
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }
  let db: Db
  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)

  // Strings that must never reach a staff member who does not hold ops_pii.
  const SECRETS = ['Riley Rider', '555-0199', 'SecretStreet 12', 'Elm Avenue 9', 'Dana Driver', 'D1234567', '555-0100']

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db)
    as('d1', 'save_driver_application', { full_name: 'Dana Driver', phone: '555-0100', licence_number: 'D1234567', licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as('d1', 'save_driver_vehicle', { vehicle_id: 'v-d1', plate: 'ABC123', make: 'T', model: 'C', vehicle_class: 'share' })
    as('d1', 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: 'd1', decision: 'approved' })
    for (const purpose of ['dispatch_availability', 'trip_tracking']) as('d1', 'set_location_consent', { purpose, granted: 1, notice_version: 'v' })
    as('d1', 'update_driver_location', { ...SYDNEY, service_radius_km: 10 })
    as('d1', 'set_driver_availability', { available: 1, vehicle_id: 'v-d1' })
    as('rider-1', 'save_rider_profile', { display_name: 'Riley Rider', phone: '555-0199', notify_email: 0, notify_sms: 0, notify_trip_updates: 1 })
    as('rider-1', 'save_ride', { ...rideToRecords({ id: 'r1', pickup: 'SecretStreet 12', pickupCoord: SYDNEY, dropoff: 'Elm Avenue 9', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1500 }) })
    as('rider-1', 'request_dispatch', { request_id: 'r1' })
    as('rider-1', 'dispatch_tick', { request_id: 'r1' })
    as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'r1' })
    as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'r1:trip', to_status: 'en_route' })
    as('d1', 'publish_driver_location', { rider_id: 'rider-1', trip_id: 'r1:trip', ...SYDNEY, accuracy_m: 5 })
    as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'r1:trip', to_status: 'arrived' }, NOW + 5000)
    as('d1', 'start_trip', { rider_id: 'rider-1', trip_id: 'r1:trip' }, NOW + 6000)
    as('d1', 'advance_trip', { rider_id: 'rider-1', trip_id: 'r1:trip', to_status: 'completed' }, NOW + 9000)
  })

  it('every action requires a signed-in caller, and every staff action requires a role', () => {
    for (const t of tools) {
      expect(t.requires_auth, t.name).toBe(true)
      if (t.name.startsWith('ops_') || /^(list_driver_applications|list_driver_vehicles_for_review|list_driver_review_log|review_driver_|list_dispatchable_drivers|get_driver_application_detail)/.test(t.name)) {
        expect(t.auth?.required, t.name).toBe(true)
        expect(t.auth?.app_roles?.length, t.name).toBeGreaterThan(0)
      }
    }
  })

  it('exact coordinates, names, addresses and licence details need ops_pii: no other staff read returns them', () => {
    const staffReads = tools.filter((t) => t.operation === 'query' && t.auth?.app_roles && !t.auth.app_roles.includes('ops_pii'))
    expect(staffReads.length).toBeGreaterThan(15)
    const byName: Record<string, unknown> = { rider_id: 'rider-1', trip_id: 'r1:trip', driver_user_id: 'd1', ref: 'r1', request_id: 'r1', status: null, reason_code: 'other', since_ms: 0 }
    for (const t of staffReads) {
      const params = Object.fromEntries(Object.entries(t.params ?? {}).filter(([, s]) => !s.optional && !('default' in s)).map(([k]) => [k, byName[k] ?? 'r1']))
      const seen = JSON.stringify(as('ops', t.name, params, NOW + 10_000))
      for (const secret of SECRETS) expect(seen, `${t.name} returned ${secret}`).not.toContain(secret)
    }
  })

  it('the personal-data reads do return them, but only after a logged reason, only to the role, and not about oneself', () => {
    const pii = { rider_id: 'rider-1', trip_id: 'r1:trip' }
    expect(as('pii', 'ops_get_trip_pii', pii, NOW + 10_000)).toEqual([]) // no logged access yet
    as('pii', 'ops_log_access', { scope: 'trip_pii', ...pii, reason_code: 'dispute' }, NOW + 10_000)
    expect(JSON.stringify(as('pii', 'ops_get_trip_pii', pii, NOW + 10_001))).toContain('SecretStreet 12')
    expect(as('pii', 'ops_get_trip_pii', pii, NOW + 10_000 + 600_001)).toEqual([]) // the 10 minutes ran out
    expect(as('rider-1', 'ops_get_trip_pii', pii, NOW + 10_001)).toEqual([]) // staff cannot read their own trip
    expect(tool('ops_get_trip_pii').auth?.app_roles).toEqual(['ops_pii'])
    expect(tool('ops_get_trip_evidence_pii').auth?.app_roles).toEqual(['ops_pii'])
    expect(tool('get_driver_application_detail').auth?.app_roles).toEqual(['ops_pii'])
  })

  it('a rider or driver reads only their own rows through the self-service actions', () => {
    const own = (user: string, name: string, params: Record<string, unknown> = {}) => JSON.stringify(as(user, name, params, NOW + 10_000))
    for (const name of ['get_rider_profile', 'list_saved_places', 'export_ride_requests', 'export_trips', 'export_trip_transitions', 'export_rider_records', 'export_account_records', 'list_my_receipts', 'list_trip_history'])
      for (const stranger of ['rider-2', 'd2']) expect(own(stranger, name), `${name} as ${stranger}`).not.toMatch(/Riley|SecretStreet|Elm Avenue|r1:trip/)
    for (const name of ['get_my_driver_application', 'list_my_driver_vehicles', 'export_driver_records', 'list_my_earnings'])
      expect(own('rider-2', name), name).not.toMatch(/Dana|D1234567|ABC123/)
    // The rider's copy of their data names no driver identity beyond what the ride itself recorded.
    expect(own('rider-1', 'export_rider_records')).not.toMatch(/D1234567|555-0100|driver_payout|platform_fee|driver_user_id/)
  })

  // Actions that create rows. Each either has a per-person count or time window in its SQL, or is named
  // here with the reason it cannot grow without bound. A new writing action fails this test until it is
  // classified, and `OPEN` ones must appear in docs/security-review.md.
  const capped = (t: Tool) => /COUNT\(\*\)|__now - \d{4,}/.test(statementsOf(t).join('\n'))
  const WHY: Record<string, string> = {
    save_ride: 'OPEN',
    cancel_ride: 'one event per legal transition, which a trip allows once',
    advance_trip: 'one event per legal transition, which a trip allows once',
    start_trip: 'one event per legal transition, which a trip allows once',
    driver_cancel_trip: 'one event per legal transition, which a trip allows once',
    report_rider_no_show: 'one event per legal transition, which a trip allows once',
    report_driver_no_show: 'one event per legal transition, which a trip allows once',
    submit_driver_application: 'guarded by the draft status',
    accept_offer: 'guarded by an open offer',
    request_dispatch: 'guarded by an existing ride; one search per ride',
    save_rider_profile: "upsert on the caller's own id",
    save_driver_application: "upsert on the caller's own id",
    set_driver_availability: "upsert on the caller's own id",
    update_driver_location: "upsert on the caller's own id",
    set_notification_prefs: "upsert on the caller's own id",
    set_location_consent: 'upsert on caller and one of two purposes',
    report_client_metrics: 'one row per domain per minute, at most 7 per call',
  }
  const OPEN_FINDINGS = Object.keys(WHY).filter((name) => WHY[name] === 'OPEN')

  it('every action that creates rows is capped, or classified with its reason', () => {
    const creators = tools.filter((t) => t.operation !== 'query' && !t.auth?.app_roles && /INSERT/.test(statementsOf(t).join('\n')))
    const uncapped = creators.filter((t) => !capped(t)).map((t) => t.name).sort()
    expect(uncapped).toEqual(Object.keys(WHY).sort())
    const security = readFileSync(join(ROOT, 'docs', 'security-review.md'), 'utf8')
    for (const name of OPEN_FINDINGS) expect(security, name).toContain(`\`${name}\``)
  })

  it('a driver can keep at most 10 vehicles, and editing one does not count against the limit', () => {
    for (let i = 0; i < 15; i++) as('d2', 'save_driver_vehicle', { vehicle_id: `v${i}`, plate: `P${i}`, make: 'T', model: 'C' })
    expect((as('d2', 'list_my_driver_vehicles') as unknown[]).length).toBe(10)
    as('d2', 'save_driver_vehicle', { vehicle_id: 'v3', plate: 'NEW', make: 'T', model: 'C' })
    expect((as('d2', 'list_my_driver_vehicles') as { id: string; plate: string }[]).find((v) => v.id === 'v3')?.plate).toBe('NEW')
    expect((as('d3', 'list_my_driver_vehicles') as unknown[]).length).toBe(0)
  })

  it('a rider can keep at most 50 saved places, and replacing one does not count against the limit', () => {
    for (let i = 0; i < 60; i++) as('rider-1', 'save_place', { place_id: `p${i}`, label: `L${i}`, address: 'x', lat: null, lng: null })
    expect((as('rider-1', 'list_saved_places') as unknown[]).length).toBe(50)
    as('rider-1', 'save_place', { place_id: 'p3', label: 'Renamed', address: 'x', lat: null, lng: null })
    expect((as('rider-1', 'list_saved_places') as { id: string; label: string }[]).find((p) => p.id === 'p3')?.label).toBe('Renamed')
    as('rider-1', 'delete_place', { place_id: 'p0' })
    as('rider-1', 'save_place', { place_id: 'new', label: 'N', address: 'x', lat: null, lng: null })
    expect((as('rider-1', 'list_saved_places') as unknown[]).length).toBe(50)
    expect((as('rider-2', 'list_saved_places') as unknown[]).length).toBe(0)
  })
})

describe('export and erasure cover a full account', () => {
  const NOW = Date.UTC(2026, 5, 1)
  const SYDNEY = { lat: -33.8688, lng: 151.2093 }
  let db: Db
  const as = (user: string, name: string, params: Record<string, unknown> = {}, now = NOW) => call(db, name, params, user, now)
  const sections = (user: string, name: string) => Object.fromEntries((as(user, name) as { section: string; records: string }[]).map((r) => [r.section, JSON.parse(r.records) as Record<string, unknown>[]]))
  const trip = { rider_id: 'rider-1', trip_id: 'r1:trip' }

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    migrate(db)
    as('d1', 'save_driver_application', { full_name: 'Dana Driver', phone: '555-0100', licence_number: 'D1234567', licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1 })
    as('d1', 'save_driver_vehicle', { vehicle_id: 'v-d1', plate: 'ABC123', make: 'T', model: 'C', vehicle_class: 'share' })
    as('d1', 'submit_driver_application')
    as('ops', 'review_driver_application', { driver_user_id: 'd1', decision: 'approved' })
    for (const purpose of ['dispatch_availability', 'trip_tracking']) as('d1', 'set_location_consent', { purpose, granted: 1, notice_version: 'v' })
    as('d1', 'update_driver_location', { ...SYDNEY, service_radius_km: 10 })
    as('d1', 'set_driver_availability', { available: 1, vehicle_id: 'v-d1' })
    as('rider-1', 'save_rider_profile', { display_name: 'Riley Rider', phone: '555-0199', notify_email: 0, notify_sms: 0, notify_trip_updates: 1 })
    as('rider-1', 'save_place', { place_id: 'home', label: 'Home', address: 'SecretStreet 12', lat: null, lng: null })
    as('rider-1', 'set_notification_prefs', { locale: 'en', push: 1, email_fallback: 1 })
    as('rider-1', 'save_ride', { ...rideToRecords({ id: 'r1', pickup: 'SecretStreet 12', pickupCoord: SYDNEY, dropoff: 'Elm Avenue 9', dropoffCoord: null, days: [], time: '', driverName: '', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1500 }) })
    as('rider-1', 'request_dispatch', { request_id: 'r1' })
    as('rider-1', 'dispatch_tick', { request_id: 'r1' })
    as('d1', 'accept_offer', { rider_id: 'rider-1', request_id: 'r1' })
    as('d1', 'advance_trip', { ...trip, to_status: 'en_route' })
    as('d1', 'publish_driver_location', { ...trip, ...SYDNEY, accuracy_m: 5 })
    as('d1', 'advance_trip', { ...trip, to_status: 'arrived' }, NOW + 5000)
    as('d1', 'start_trip', trip, NOW + 6000)
    as('d1', 'advance_trip', { ...trip, to_status: 'completed' }, NOW + 9000)
    as('rider-1', 'open_dispute', { ...trip, reason_code: 'other', note: 'rider note' }, NOW + 10_000)
    as('d1', 'report_client_event', { domain: 'request', code: 'some_code', severity: 'warn' }, NOW + 11_000)
    as('d1', 'report_client_metrics', { payload: JSON.stringify([{ d: 'request', c: 2, e: 0, s: 0, l: 10 }]) }, NOW + 11_000)
    as('rider-1', 'report_client_event', { domain: 'request', code: 'rider_code', severity: 'warn' }, NOW + 11_000)
  })

  it("the rider's export has a section for each class and only their own rows", () => {
    const s = sections('rider-1', 'export_rider_records')
    expect(Object.keys(s).sort()).toEqual(['assignments', 'dispatch_requests', 'disputes', 'fare_adjustments', 'fare_quotes', 'fare_statements', 'quotes', 'recorded_drivers', 'recorded_vehicles', 'refund_requests', 'trip_lifecycle', 'trip_lifecycle_events'])
    expect(s.assignments).toHaveLength(1)
    expect(s.fare_statements).toHaveLength(1)
    expect(s.trip_lifecycle_events.length).toBeGreaterThan(0)
    expect(s.disputes).toMatchObject([{ reason_code: 'other', note: 'rider note' }])
    expect(JSON.stringify(s)).not.toMatch(/driver_user_id|driver_payout_cents|platform_fee_cents|commission_bp|actor_id|D1234567|555-0100/)
    for (const [key, rows] of Object.entries(sections('rider-2', 'export_rider_records'))) expect(rows, key).toEqual([])
    const account = sections('rider-1', 'export_account_records')
    expect(account.notification_prefs).toMatchObject([{ email_fallback: 1 }])
    expect(account.notifications.length).toBeGreaterThan(0)
    expect(account.client_events).toMatchObject([{ code: 'rider_code' }])
  })

  it("the driver's export has their positions, offers and diagnostics, and not the rider's data", () => {
    const s = sections('d1', 'export_driver_records')
    expect(s.locations.map((l) => l.source).sort()).toEqual(['dispatch'].concat(db.prepare('SELECT 1 FROM trip_locations').all().length ? ['trip'] : []).sort())
    expect(s.offers).toMatchObject([{ request_id: 'r1', status: 'completed' }])
    expect(JSON.stringify(s)).not.toMatch(/rider-1|SecretStreet|Riley/)
    expect(sections('d1', 'export_account_records').location_consents).toHaveLength(2)
    expect(sections('d1', 'export_account_records').client_events).toMatchObject([{ code: 'some_code' }])
    expect(JSON.stringify(sections('rider-2', 'export_driver_records'))).toBe(JSON.stringify({ locations: [], offers: [] }))
  })

  // Every text column that can name a person. After erasing, the only rows left that name them are the
  // ones the inventory says are kept, or the pseudonymous references listed in docs/privacy.md.
  const mentions = (db: Db, who: string) => {
    const found: Record<string, number> = {}
    for (const table of tablesIn(db)) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).filter((c) => c.type === 'TEXT').map((c) => c.name)
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(' OR ')}`).get(...cols.map(() => who)) as { n: number }).n
      if (n) found[table] = n
    }
    return found
  }
  const erase = (user: string) => {
    as(user, 'delete_my_rider_data', {}, NOW + 20_000)
    as(user, 'delete_my_driver_data', {}, NOW + 20_000)
  }

  it("erasing a rider leaves only the staff audit trail and the driver's own notifications about their trip", () => {
    expect(Object.keys(mentions(db, 'rider-1')).length).toBeGreaterThan(10) // the scan sees the data it is about to prove gone
    erase('rider-1')
    expect(mentions(db, 'rider-1')).toEqual({ notifications: expect.any(Number) }) // the driver's inbox, which expires in 30 days
    const left = db.prepare("SELECT user_id FROM notifications WHERE rider_id = 'rider-1'").all()
    expect(left.every((r: { user_id: string }) => r.user_id === 'd1')).toBe(true)
    erase('rider-1') // idempotent
    expect(Object.keys(mentions(db, 'rider-1'))).toEqual(['notifications'])
    run_purge()
  })

  const run_purge = () => {
    as('anyone', 'purge_expired_data', {}, NOW + 31 * 86_400_000)
    expect(mentions(db, 'rider-1')).toEqual({})
  }

  it('erasing a driver removes their own data and unlinks their account; the references in riders\' trips are the documented ones', () => {
    erase('d1')
    const left = Object.keys(mentions(db, 'd1')).sort()
    expect(left).toEqual(['dispatch_offers', 'driver_review_log', 'fare_statements', 'notifications', 'trip_lifecycle', 'trip_lifecycle_events', 'trip_transitions'])
    for (const table of ['driver_applications', 'driver_vehicles', 'driver_availability', 'driver_locations', 'trip_locations', 'location_consents', 'client_events', 'client_metrics'])
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n === 0 || !(table in mentions(db, 'd1')), table).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM drivers WHERE user_id IS NOT NULL').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'd1'").get()).toEqual({ n: 0 }) // their inbox is gone; the rider's still names them as the sender
    // The rider's own history survives the driver leaving.
    expect((as('rider-1', 'export_trips') as unknown[]).length).toBe(1)
    const refs = ['dispatch_offers', 'fare_statements', 'notifications', 'trip_lifecycle', 'trip_lifecycle_events', 'trip_transitions'].map((t) => DATA_CLASSES.find((c) => c.id === t)!)
    for (const c of refs) expect(c.erasedBy, c.id).toBe('delete_my_rider_data')
  })
})
