import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEDUPE_MS, FLUSH_MS, MAX_EVENTS_PER_MINUTE, SLOW_MS, domainOf, flushMetrics, installTelemetry, recordCall, redact, reportError, resetTelemetry, takeMetrics, timed } from './telemetry'

const sink = () => {
  const call = vi.fn(async (_name: string, _params?: Record<string, unknown>): Promise<unknown> => undefined)
  const capture = vi.fn()
  return { actions: { call }, logs: { capture }, call, capture }
}
const reports = (s: ReturnType<typeof sink>) => s.call.mock.calls.filter((c) => c[0] === 'report_client_event').map((c) => c[1] as Record<string, unknown>)

let s: ReturnType<typeof sink>
beforeEach(() => {
  resetTelemetry()
  s = sink()
})
afterEach(() => {
  resetTelemetry()
  vi.useRealTimers()
})

describe('domains', () => {
  it('puts every action in the area an operator would look in', () => {
    expect(domainOf('dispatch_tick')).toBe('dispatch')
    expect(domainOf('accept_offer')).toBe('dispatch')
    expect(domainOf('publish_driver_location')).toBe('tracking')
    expect(domainOf('get_driver_location')).toBe('tracking')
    expect(domainOf('list_pending_deliveries')).toBe('notification')
    expect(domainOf('report_push_result')).toBe('notification')
    expect(domainOf('get_receipt')).toBe('payment')
    expect(domainOf('list_my_earnings')).toBe('payment')
    expect(domainOf('advance_trip')).toBe('transition')
    expect(domainOf('cancel_ride')).toBe('transition')
    expect(domainOf('create_quote')).toBe('request')
    expect(domainOf('save_ride')).toBe('request')
    expect(domainOf('something_new')).toBe('request')
  })
})

describe('redaction', () => {
  it('removes anything that could identify a person', () => {
    const text = redact('failed for dana@example.com at -33.86881, 151.20931 call +61 412 345 678 token abcdefghijklmnopqrstuvwxyz0123456789')
    expect(text).not.toMatch(/dana|example|-33\.868|151\.209|412|abcdefgh/)
    expect(text).toContain('[email]')
    expect(text).toContain('[coords]')
    expect(text).toContain('[number]')
    expect(text).toContain('[token]')
  })

  it('keeps ordinary diagnostics readable, collapses whitespace, and clips', () => {
    expect(redact('expected  arrived,\n got en_route')).toBe('expected arrived, got en_route')
    expect(redact('ab '.repeat(200))).toHaveLength(200)
    expect(redact(undefined)).toBe('')
    expect(redact(new Error('boom'))).toBe('Error: boom')
  })
})

describe('metrics', () => {
  it('counts calls, failures and slow calls per domain and then clears them', () => {
    recordCall('dispatch', true, 100)
    recordCall('dispatch', false, SLOW_MS + 1)
    recordCall('maps', true, 50)
    expect(JSON.parse(takeMetrics()!)).toEqual([{ d: 'dispatch', c: 2, e: 1, s: 1, l: SLOW_MS + 101 }, { d: 'maps', c: 1, e: 0, s: 0, l: 50 }])
    expect(takeMetrics()).toBeNull()
  })

  it('sends the counters on request, and not when there are none', async () => {
    installTelemetry(s)
    await flushMetrics()
    expect(s.call).not.toHaveBeenCalled()
    recordCall('request', true, 10)
    await flushMetrics()
    expect(s.call).toHaveBeenCalledWith('report_client_metrics', { payload: JSON.stringify([{ d: 'request', c: 1, e: 0, s: 0, l: 10 }]) })
  })

  it('flushes every minute and when the page hides', async () => {
    vi.useFakeTimers()
    installTelemetry(s)
    recordCall('request', true, 10)
    await vi.advanceTimersByTimeAsync(FLUSH_MS)
    expect(s.call.mock.calls.filter((c) => c[0] === 'report_client_metrics')).toHaveLength(1)
    recordCall('request', true, 10)
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.call.mock.calls.filter((c) => c[0] === 'report_client_metrics')).toHaveLength(2)
  })

  it('never throws if the report fails', async () => {
    installTelemetry(s)
    s.call.mockRejectedValue(new Error('offline'))
    recordCall('request', true, 10)
    await expect(flushMetrics()).resolves.toBeUndefined()
  })
})

describe('reportError', () => {
  it('logs to the platform and the database with only non-personal fields', () => {
    installTelemetry(s)
    reportError({ domain: 'dispatch', code: 'accept_failed', action: 'accept_offer', status: 503, latencyMs: 2400, tripId: 'r1:trip', requestId: 'r1', error: new Error('upstream said no for dana@example.com') })
    expect(s.capture).toHaveBeenCalledWith('error', 'loopride.dispatch', 'accept_failed', { domain: 'dispatch', code: 'accept_failed', action: 'accept_offer', status: 503, latencyMs: 2400, tripId: 'r1:trip', requestId: 'r1', detail: 'upstream said no for [email]' })
    expect(reports(s)).toEqual([{ domain: 'dispatch', code: 'accept_failed', severity: 'error', action: 'accept_offer', status: 503, latency_ms: 2400, trip_id: 'r1:trip', request_id: 'r1', detail: 'upstream said no for [email]' }])
    expect(JSON.stringify([s.capture.mock.calls, s.call.mock.calls])).not.toContain('dana')
  })

  it('treats a 4xx as a warning and a server or network failure as an error', () => {
    installTelemetry(s)
    reportError({ domain: 'request', code: 'a_failed', error: Object.assign(new Error('x'), { status: 401 }) })
    reportError({ domain: 'request', code: 'b_failed', error: Object.assign(new Error('x'), { status: 500 }) })
    reportError({ domain: 'request', code: 'c_failed', error: new Error('network') })
    expect(reports(s).map((r) => [r.code, r.severity])).toEqual([['a_failed', 'warn'], ['b_failed', 'error'], ['c_failed', 'error']])
    expect(s.capture.mock.calls.map((c) => c[0])).toEqual(['warn', 'error', 'error'])
  })

  it('honours an explicit severity', () => {
    installTelemetry(s)
    reportError({ domain: 'transition', code: 'offer_lost', severity: 'warn', error: Object.assign(new Error('x'), { status: 500 }) })
    expect(reports(s)[0].severity).toBe('warn')
  })

  it('sends the same failure once per 30 seconds, but logs every one', () => {
    installTelemetry(s)
    for (let i = 0; i < 5; i++) reportError({ domain: 'tracking', code: 'publish_failing' }, 1_000 + i)
    expect(reports(s)).toHaveLength(1)
    expect(s.capture).toHaveBeenCalledTimes(5)
    reportError({ domain: 'tracking', code: 'publish_failing' }, 1_000 + DEDUPE_MS)
    expect(reports(s)).toHaveLength(2)
    reportError({ domain: 'tracking', code: 'different_code' }, 1_001)
    expect(reports(s)).toHaveLength(3)
  })

  it('caps what one device sends per minute', () => {
    installTelemetry(s)
    for (let i = 0; i < 25; i++) reportError({ domain: 'request', code: `error_${String.fromCharCode(97 + i)}` }, 5_000 + i)
    expect(reports(s)).toHaveLength(MAX_EVENTS_PER_MINUTE)
    reportError({ domain: 'request', code: 'later_one' }, 5_000 + 61_000)
    expect(reports(s)).toHaveLength(MAX_EVENTS_PER_MINUTE + 1)
  })

  it('clamps latency and clips fields, and never throws', () => {
    installTelemetry(s)
    reportError({ domain: 'request', code: 'slow_one', latencyMs: 9_999_999_999, detail: 'yy '.repeat(200) })
    expect(reports(s)[0]).toMatchObject({ latency_ms: 3_600_000 })
    expect(String(reports(s)[0].detail)).toHaveLength(200)
    s.call.mockImplementation(() => { throw new Error('sync boom') })
    expect(() => reportError({ domain: 'request', code: 'again_one' })).not.toThrow()
    resetTelemetry()
    expect(() => reportError({ domain: 'request', code: 'no_sink' })).not.toThrow()
  })
})

describe('instrumentActions', () => {
  const wrapped = () => {
    const actions = { call: vi.fn(async (_n: string, _p?: Record<string, unknown>): Promise<unknown> => 'ok') }
    installTelemetry({ actions, logs: s.logs })
    return { actions }
  }

  it('passes results through and counts the call under its domain', async () => {
    const { actions } = wrapped()
    await expect(actions.call('dispatch_tick', { request_id: 'r1' })).resolves.toBe('ok')
    expect(JSON.parse(takeMetrics()!)).toEqual([{ d: 'dispatch', c: 1, e: 0, s: 0, l: expect.any(Number) }])
  })

  it('counts a failure, reports it with the action, status and ids, and rethrows the original error', async () => {
    const boom = Object.assign(new Error('actions.advance_trip failed: 503'), { status: 503 })
    const actions = { call: vi.fn().mockRejectedValue(boom) as unknown as (n: string, p?: Record<string, unknown>) => Promise<unknown> }
    const sk = sink()
    installTelemetry({ actions, logs: sk.logs })
    await expect(actions.call('advance_trip', { trip_id: 'r1:trip', rider_id: 'rider-1', to_status: 'arrived' })).rejects.toBe(boom)
    expect(JSON.parse(takeMetrics()!)).toEqual([{ d: 'transition', c: 1, e: 1, s: 0, l: expect.any(Number) }])
    expect(sk.capture).toHaveBeenCalledWith('error', 'loopride.transition', 'action_failed', expect.objectContaining({ action: 'advance_trip', status: 503, tripId: 'r1:trip' }))
    expect(JSON.stringify(sk.capture.mock.calls)).not.toContain('rider-1') // person ids are never recorded
  })

  it('does not instrument its own reports, so a failing report cannot loop', async () => {
    const calls: string[] = []
    const actions = { call: (async (name: string) => { calls.push(name); if (name === 'report_client_event') throw new Error('down') }) as (n: string, p?: Record<string, unknown>) => Promise<unknown> }
    installTelemetry({ actions })
    await expect(actions.call('report_client_event', {})).rejects.toThrow()
    await expect(actions.call('report_client_metrics', {})).resolves.toBeUndefined()
    expect(takeMetrics()).toBeNull()
    expect(calls.filter((c) => c === 'report_client_event')).toHaveLength(1)
  })
})

describe('timed', () => {
  it('counts a success without reporting', async () => {
    installTelemetry(s)
    await expect(timed('maps', 'geocode_failed', async () => 42)).resolves.toBe(42)
    expect(JSON.parse(takeMetrics()!)).toEqual([{ d: 'maps', c: 1, e: 0, s: 0, l: expect.any(Number) }])
    expect(reports(s)).toEqual([])
  })

  it('counts and reports a failure as a warning, then rethrows', async () => {
    installTelemetry(s)
    await expect(timed('maps', 'route_failed', async () => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(JSON.parse(takeMetrics()!)).toMatchObject([{ d: 'maps', c: 1, e: 1 }])
    expect(reports(s)).toMatchObject([{ domain: 'maps', code: 'route_failed', severity: 'warn', detail: 'nope' }])
  })

  it('does not count a cancelled request as a failure', async () => {
    installTelemetry(s)
    await expect(timed('maps', 'geocode_failed', async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) })).rejects.toThrow('aborted')
    expect(takeMetrics()).toBeNull()
    expect(reports(s)).toEqual([])
  })
})
