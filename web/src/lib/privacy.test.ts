import { beforeEach, describe, expect, it, vi } from 'vitest'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions } }))

import { NOTICE_VERSION, PURPOSES, isCurrent, loadConsents, noticeFor, runRetention, setLocationConsent } from './privacy'
import { DATA_CLASSES, RETENTION_SUMMARY } from './privacyInventory'

beforeEach(() => {
  actions.call.mockReset()
})

describe('consent records', () => {
  it('maps the server rows by purpose, and a purpose never answered has no entry', async () => {
    actions.call.mockResolvedValue([{ purpose: 'trip_tracking', granted: 1, notice_version: NOTICE_VERSION, granted_at: 5, withdrawn_at: null }])
    const all = await loadConsents()
    expect(actions.call).toHaveBeenCalledWith('get_my_location_consents', {})
    expect(all).toEqual({ trip_tracking: { granted: true, noticeVersion: NOTICE_VERSION, grantedAt: 5, withdrawnAt: null } })
    expect(isCurrent(all.dispatch_availability)).toBe(false)
    expect(isCurrent(all.trip_tracking)).toBe(true)
  })

  it('a withdrawn consent, or one given for older wording, does not count', () => {
    expect(isCurrent({ granted: false, noticeVersion: NOTICE_VERSION, grantedAt: 1, withdrawnAt: 2 })).toBe(false)
    expect(isCurrent({ granted: true, noticeVersion: 'older', grantedAt: 1, withdrawnAt: null })).toBe(false)
    expect(isCurrent(undefined)).toBe(false)
  })

  it('sends the purpose, a 0/1 value and the wording version that was shown', async () => {
    actions.call.mockResolvedValue(undefined)
    await setLocationConsent('dispatch_availability', true)
    await setLocationConsent('trip_tracking', false)
    expect(actions.call).toHaveBeenNthCalledWith(1, 'set_location_consent', { purpose: 'dispatch_availability', granted: 1, notice_version: NOTICE_VERSION })
    expect(actions.call).toHaveBeenNthCalledWith(2, 'set_location_consent', { purpose: 'trip_tracking', granted: 0, notice_version: NOTICE_VERSION })
  })

  it('has a plain-language notice and a withdrawal effect for each purpose', () => {
    expect(PURPOSES.map((p) => p.purpose)).toEqual(['dispatch_availability', 'trip_tracking'])
    for (const p of PURPOSES) {
      expect(p.notice.length).toBeGreaterThan(80)
      expect(p.withdrawEffect.length).toBeGreaterThan(20)
      expect(noticeFor(p.purpose)).toBe(p)
    }
    // The notices state the periods the server enforces.
    expect(noticeFor('trip_tracking').notice).toMatch(/24 hours/)
    expect(noticeFor('trip_tracking').notice).toMatch(/30 days/)
    expect(noticeFor('dispatch_availability').notice).toMatch(/24 hours/)
  })
})

describe('retention trigger', () => {
  it('asks the server to expire data, then not again for six hours', async () => {
    actions.call.mockResolvedValue(undefined)
    expect(await runRetention(1_700_000_000_000)).toBe(true)
    expect(actions.call).toHaveBeenCalledWith('purge_expired_data', {})
    expect(await runRetention(1_700_000_000_000 + 5 * 3_600_000)).toBe(false)
    expect(await runRetention(1_700_000_000_000 + 6 * 3_600_000)).toBe(true)
    expect(actions.call).toHaveBeenCalledTimes(2)
  })

  it('never throws, so a failed purge cannot break the app', async () => {
    actions.call.mockRejectedValue(new Error('offline'))
    await expect(runRetention(1_700_000_000_000)).resolves.toBe(false)
  })
})

describe('retention summary', () => {
  it('lists each short-lived class with its period, matching the notices', () => {
    expect(RETENTION_SUMMARY).toEqual([
      'Driver dispatch positions: 24 hours',
      'Live trip positions: 24 hours',
      'Trip evidence snapshots: 30 days',
      'Notifications: 30 days',
      'Diagnostic events: 14 days',
      'Diagnostic counters: 14 days',
    ])
  })

  it('every needs-human class says what is open', () => {
    for (const c of DATA_CLASSES.filter((d) => d.decision)) expect(c.note, c.id).toBeTruthy()
  })
})
