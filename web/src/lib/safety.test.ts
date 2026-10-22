// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import mcpFile from '../../../mcp.json'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions } }))

import { SAFETY_CATEGORIES, SAFETY_COPY, REPORT_WINDOW_MS, accountBlocked, canReportSafety, isUrgent, listMySafetyReports, reportExists, submitSafetyReport } from './safety'

const submit = (mcpFile.tools as unknown as { name: string; statements: string[] }[]).find((t) => t.name === 'submit_safety_report')!
const sqlList = (marker: string) => [...new RegExp(`${marker} IN \\(([^)]*)\\)`).exec(submit.statements[0])![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])

beforeEach(() => { actions.call.mockReset() })

describe('safety categories', () => {
  it('are exactly the categories the server accepts, with the same urgent ones', () => {
    const accepted = [...submit.statements[0].matchAll(/:category IN \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]))
    const all = accepted.find((list) => list.length === SAFETY_CATEGORIES.length)!
    expect(SAFETY_CATEGORIES.map((c) => c.code).sort()).toEqual([...all].sort())
    const urgentOnServer = accepted.find((list) => list.length < SAFETY_CATEGORIES.length)!
    expect(SAFETY_CATEGORIES.filter((c) => c.urgent).map((c) => c.code).sort()).toEqual([...urgentOnServer].sort())
    expect(sqlList(':category')).toBeDefined()
  })

  it('leads with the urgent ones and knows which are urgent', () => {
    expect(SAFETY_CATEGORIES[0].code).toBe('emergency')
    expect(isUrgent('assault')).toBe(true)
    expect(isUrgent('harassment')).toBe(false)
    expect(isUrgent('nope')).toBe(false)
  })
})

describe('copy', () => {
  it('names no emergency number and promises no response time', () => {
    const text = Object.values(SAFETY_COPY).join(' ')
    expect(text).not.toMatch(/\b(911|112|999|000)\b/)
    expect(text).not.toMatch(/\bminutes?\b|\bhours?\b|within \d/i)
    expect(SAFETY_COPY.emergency).toMatch(/emergency services/)
    expect(SAFETY_COPY.limits).toMatch(/not an emergency service/)
    expect(SAFETY_COPY.sentUrgent).toMatch(/not a substitute for emergency services/)
  })
})

describe('canReportSafety', () => {
  const now = Date.UTC(2026, 5, 1)
  it('is allowed while the trip is under way, whatever its age', () => {
    for (const phase of ['scheduled', 'en_route', 'arrived', 'in_progress'] as const) expect(canReportSafety({ phase, endedAt: null }, now)).toBe(true)
  })
  it('is allowed for 7 days after the trip ended and not after', () => {
    expect(canReportSafety({ phase: 'completed', endedAt: now - REPORT_WINDOW_MS + 1 }, now)).toBe(true)
    expect(canReportSafety({ phase: 'cancelled', endedAt: now - REPORT_WINDOW_MS }, now)).toBe(false)
    expect(canReportSafety({ phase: 'completed', endedAt: null }, now)).toBe(false)
  })
})

describe('calls', () => {
  it('sends the trip, the key, the category and a trimmed note', async () => {
    await submitSafetyReport({ riderId: 'rider-1', tripId: 'r1:trip', category: 'harassment', note: '  rude  ', key: 'k' })
    expect(actions.call).toHaveBeenCalledWith('submit_safety_report', { rider_id: 'rider-1', trip_id: 'r1:trip', request_key: 'k', category: 'harassment', note: 'rude' })
    await submitSafetyReport({ riderId: 'rider-1', tripId: 'r1:trip', category: 'other', note: '   ', key: 'k2' })
    expect(actions.call).toHaveBeenLastCalledWith('submit_safety_report', expect.objectContaining({ note: null }))
  })

  it('confirms a report by key, because the server ignores a refused one without an error', async () => {
    actions.call.mockResolvedValue([{ id: 'rider-1:abc' }])
    expect(await reportExists('abc')).toBe(true)
    expect(await reportExists('ab')).toBe(false) // suffix match on the whole key
    actions.call.mockResolvedValue([])
    expect(await reportExists('abc')).toBe(false)
    expect(await listMySafetyReports()).toEqual([])
  })

  it('reports a block, and treats an unknown standing as not blocked', async () => {
    actions.call.mockResolvedValue([{ rider_blocked: 1 }])
    expect(await accountBlocked()).toBe(true)
    actions.call.mockResolvedValue([{ rider_blocked: 0 }])
    expect(await accountBlocked()).toBe(false)
    actions.call.mockResolvedValue(undefined)
    expect(await accountBlocked()).toBe(false)
    actions.call.mockImplementation(async () => { throw new Error('down') })
    expect(await accountBlocked()).toBe(false)
  })
})
