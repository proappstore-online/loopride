import { beforeEach, describe, expect, it, vi } from 'vitest'

const { actions, notifyUser, subscribe, isSubscribed } = vi.hoisted(() => ({ actions: { call: vi.fn() }, notifyUser: vi.fn(), subscribe: vi.fn(), isSubscribed: vi.fn() }))
const { tel } = vi.hoisted(() => ({ tel: { reportError: vi.fn(), recordCall: vi.fn() } }))
vi.mock('./telemetry', async (importOriginal) => ({ ...(await importOriginal<typeof import('./telemetry')>()), reportError: tel.reportError, recordCall: tel.recordCall }))
vi.mock('./app', () => ({ app: { actions, notifications: { notifyUser, subscribe, isSubscribed } } }))

import { CRITICAL_KINDS, DEFAULT_PREFS, MAX_PER_PUMP, deliverPending, enablePush, loadInbox, loadPrefs, markRead, renderNotification, savePrefs, type Kind } from './notifications'

const KINDS: Kind[] = ['offer_received', 'driver_assigned', 'driver_en_route', 'driver_arrived', 'trip_started', 'receipt_ready', 'trip_cancelled', 'rider_no_show', 'driver_no_show', 'dispute_resolved']

beforeEach(() => {
  tel.reportError.mockReset()
  tel.recordCall.mockReset()
  actions.call.mockReset()
  notifyUser.mockReset()
  subscribe.mockReset()
  isSubscribed.mockReset()
})

describe('rendering and localization', () => {
  it('has a title and body for every kind in every language', () => {
    for (const locale of ['en', 'es']) {
      for (const kind of KINDS) {
        const t = renderNotification({ kind, params: {} }, locale)
        expect(t.title.length, `${locale} ${kind}`).toBeGreaterThan(3)
        expect(t.body.length, `${locale} ${kind}`).toBeGreaterThan(3)
      }
    }
  })

  it('writes in the reader\'s language, with English as the fallback', () => {
    expect(renderNotification({ kind: 'driver_arrived', params: {} }, 'en').title).toBe('Your driver has arrived')
    expect(renderNotification({ kind: 'driver_arrived', params: {} }, 'es').title).toBe('Tu conductor llegó')
    expect(renderNotification({ kind: 'driver_arrived', params: {} }, 'fr').title).toBe('Your driver has arrived')
    expect(renderNotification({ kind: 'driver_arrived', params: {} }).title).toBe('Your driver has arrived')
  })

  it('fills in the parameters', () => {
    expect(renderNotification({ kind: 'driver_assigned', params: { driver: 'Dana', plate: 'RS-9' } }, 'en').body).toBe('Dana · RS-9 accepted your ride.')
    expect(renderNotification({ kind: 'receipt_ready', params: { total_cents: 1150 } }, 'en').body).toBe('Trip total $11.50.')
    expect(renderNotification({ kind: 'receipt_ready', params: { total_cents: 1150 } }, 'es').body).toBe('Total del viaje $11.50.')
    expect(renderNotification({ kind: 'offer_received', params: { pickup: 'A', dropoff: 'B' } }, 'en').body).toContain('A → B')
    expect(renderNotification({ kind: 'rider_no_show', params: { fee_cents: 800 } }, 'en').body).toContain('No-show fee $8.00')
  })

  it('describes who cancelled, why, and any fee, and survives missing parameters', () => {
    expect(renderNotification({ kind: 'trip_cancelled', params: { by: 'rider', reason: 'wrong_pickup', fee_cents: 500 } }, 'en').body).toBe('The rider cancelled: wrong pickup location. Cancellation fee $5.00.')
    expect(renderNotification({ kind: 'trip_cancelled', params: { by: 'driver', reason: 'vehicle_issue', fee_cents: 0 } }, 'es').body).toBe('El conductor canceló: un problema con el vehículo.')
    expect(renderNotification({ kind: 'trip_cancelled', params: { by: 'ops', reason: 'ops_cancelled', fee_cents: 0 } }, 'en').body).toBe('Support cancelled this trip.')
    expect(renderNotification({ kind: 'trip_cancelled', params: { by: 'rider', reason: 'made_up' } }, 'en').body).toContain('another reason')
    expect(() => renderNotification({ kind: 'driver_assigned', params: {} }, 'en')).not.toThrow()
    expect(renderNotification({ kind: 'dispute_resolved', params: { decision: 'upheld' } }, 'en').body).toBe('Support upheld your report.')
  })

  it('treats the same critical kinds as the server does', () => {
    expect([...CRITICAL_KINDS].sort()).toEqual(['driver_arrived', 'driver_assigned', 'driver_no_show', 'receipt_ready', 'rider_no_show', 'trip_cancelled'])
  })
})

describe('inbox and preferences', () => {
  it('maps the inbox and tolerates malformed parameters', async () => {
    actions.call.mockResolvedValueOnce([
      { id: 'a', kind: 'driver_assigned', role: 'rider', trip_id: 't', request_id: 'r', link: '/trip/r', params: '{"driver":"Dana"}', critical: 1, created_at: 5, read_at: null },
      { id: 'b', kind: 'trip_started', role: 'rider', trip_id: 't', request_id: 'r', link: '/trip/r', params: 'not json', critical: 0, created_at: 6, read_at: 7 },
    ])
    const items = await loadInbox()
    expect(items[0]).toMatchObject({ id: 'a', params: { driver: 'Dana' }, critical: true, readAt: null, link: '/trip/r' })
    expect(items[1]).toMatchObject({ params: {}, critical: false, readAt: 7 })
    await markRead('a')
    expect(actions.call).toHaveBeenLastCalledWith('mark_notifications_read', { id: 'a' })
    await markRead()
    expect(actions.call).toHaveBeenLastCalledWith('mark_notifications_read', { id: null })
  })

  it('defaults to push on and email off, and sends 0/1 flags', async () => {
    actions.call.mockResolvedValueOnce([])
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS).toMatchObject({ push: true, emailFallback: false, emailConsentAt: null })
    actions.call.mockResolvedValueOnce([{ locale: 'es', push: 0, email_fallback: 1, email_consent_at: 99 }])
    expect(await loadPrefs()).toEqual({ locale: 'es', push: false, emailFallback: true, emailConsentAt: 99 })
    await savePrefs({ locale: 'en', push: false, emailFallback: true })
    expect(actions.call).toHaveBeenLastCalledWith('set_notification_prefs', { locale: 'en', push: 0, email_fallback: 1 })
  })

  it('enables push only if the browser really ends up subscribed', async () => {
    subscribe.mockResolvedValue(undefined)
    isSubscribed.mockResolvedValue(true)
    expect(await enablePush()).toBe(true)
    isSubscribed.mockResolvedValue(false)
    expect(await enablePush()).toBe(false)
    subscribe.mockRejectedValue(new Error('denied'))
    expect(await enablePush()).toBe(false)
  })
})

describe('deliverPending', () => {
  const row = (extra = {}) => ({ recipient: 'rider-1', id: 'r1:trip:driver_arrived', kind: 'driver_arrived', link: '/trip/r1', params: '{}', channel: 'push', locale: 'en', ...extra })
  const serve = (rows: unknown[]) => actions.call.mockImplementation(async (name: string) => (name === 'list_pending_deliveries' ? rows : undefined))
  const reports = () => actions.call.mock.calls.filter((c) => /^report_/.test(c[0]))

  it('sends a push in the recipient\'s language with a link to the right trip, and reports success', async () => {
    serve([row({ locale: 'es' })])
    notifyUser.mockResolvedValue({ sent: 1, failed: 0 })
    expect(await deliverPending('https://app.example')).toEqual({ sent: 1, failed: 0, skipped: 0 })
    expect(notifyUser).toHaveBeenCalledWith('rider-1', { title: 'Tu conductor llegó', body: 'Te espera en el punto de recogida.', url: 'https://app.example/trip/r1', tag: 'r1:trip:driver_arrived' }, { channel: 'push' })
    expect(reports()).toEqual([['report_push_result', { recipient: 'rider-1', notification_id: 'r1:trip:driver_arrived', outcome: 'sent', error: null }]])
  })

  it('reports a push that reached no device as failed, so the server retries it', async () => {
    serve([row()])
    notifyUser.mockResolvedValue({ sent: 0, failed: 1 })
    expect(await deliverPending('')).toEqual({ sent: 0, failed: 1, skipped: 0 })
    expect(reports()[0][1]).toMatchObject({ outcome: 'failed', error: 'no push delivered' })
  })

  it('reports a thrown error (offline, rate limit) as failed with its message', async () => {
    serve([row()])
    notifyUser.mockRejectedValue(new Error('429 slow down'))
    await deliverPending('')
    expect(reports()[0][1]).toMatchObject({ outcome: 'failed', error: '429 slow down' })
  })

  it('sends email fallbacks through the platform email channel and maps its outcomes', async () => {
    serve([row({ channel: 'email', id: 'a' }), row({ channel: 'email', id: 'b' }), row({ channel: 'email', id: 'c' })])
    notifyUser.mockResolvedValueOnce({ sent: 0, failed: 0, email: 'sent' }).mockResolvedValueOnce({ sent: 0, failed: 0, email: 'skipped', skipped: 'unsubscribed' }).mockResolvedValueOnce({ sent: 0, failed: 0, email: 'failed' })
    expect(await deliverPending('')).toEqual({ sent: 1, failed: 1, skipped: 1 })
    expect(notifyUser).toHaveBeenCalledWith('rider-1', expect.anything(), { channel: 'email' })
    expect(reports().map((r) => [r[0], r[1].outcome, r[1].error])).toEqual([
      ['report_email_result', 'sent', null],
      ['report_email_result', 'skipped', 'unsubscribed'],
      ['report_email_result', 'failed', 'email failed'],
    ])
  })

  it('sends only a few at a time to stay inside the platform rate limit', async () => {
    serve(Array.from({ length: 12 }, (_, i) => row({ id: `n${i}` })))
    notifyUser.mockResolvedValue({ sent: 1, failed: 0 })
    await deliverPending('')
    expect(notifyUser).toHaveBeenCalledTimes(MAX_PER_PUMP)
  })

  it('does nothing when nothing is owed, and never runs two pumps at once', async () => {
    serve([])
    expect(await deliverPending('')).toEqual({ sent: 0, failed: 0, skipped: 0 })
    let release: () => void = () => undefined
    actions.call.mockImplementation(async (name: string) => (name === 'list_pending_deliveries' ? new Promise((r) => { release = () => r([]) }) : undefined))
    const first = deliverPending('')
    expect(await deliverPending('')).toEqual({ sent: 0, failed: 0, skipped: 0 })
    release()
    await first
    expect(actions.call.mock.calls.filter((c) => c[0] === 'list_pending_deliveries')).toHaveLength(2)
  })

  it('keeps going if reporting one result fails, so the next pump retries it', async () => {
    actions.call.mockImplementation(async (name: string) => {
      if (name === 'list_pending_deliveries') return [row({ id: 'a' }), row({ id: 'b' })]
      if (name === 'report_push_result') throw new Error('offline')
      return undefined
    })
    notifyUser.mockResolvedValue({ sent: 1, failed: 0 })
    expect(await deliverPending('')).toEqual({ sent: 2, failed: 0, skipped: 0 })
    expect(notifyUser).toHaveBeenCalledTimes(2)
  })

  it('reports a delivery that failed, without the message, and counts every attempt', async () => {
    serve([row(), row({ id: 'b', channel: 'email' })])
    notifyUser.mockResolvedValueOnce({ sent: 0, failed: 1 }).mockResolvedValueOnce({ sent: 0, failed: 0, email: 'failed' })
    await deliverPending('')
    expect(tel.reportError).toHaveBeenCalledWith({ domain: 'notification', code: 'push_not_delivered', severity: 'warn', detail: 'no push delivered' })
    expect(tel.reportError).toHaveBeenCalledWith({ domain: 'notification', code: 'email_not_delivered', severity: 'warn', detail: 'email failed' })
    expect(tel.recordCall).toHaveBeenCalledTimes(2)
    expect(tel.recordCall).toHaveBeenCalledWith('notification', false, expect.any(Number))
    expect(JSON.stringify(tel.reportError.mock.calls)).not.toContain('Tu conductor')
  })

  it('does not report a success or an unsubscribed recipient as a failure', async () => {
    serve([row(), row({ id: 'b', channel: 'email' })])
    notifyUser.mockResolvedValueOnce({ sent: 1, failed: 0 }).mockResolvedValueOnce({ sent: 0, failed: 0, email: 'skipped', skipped: 'unsubscribed' })
    await deliverPending('')
    expect(tel.reportError).not.toHaveBeenCalled()
    expect(tel.recordCall).toHaveBeenCalledWith('notification', true, expect.any(Number))
  })
})
