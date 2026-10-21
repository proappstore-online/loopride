import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions } }))

import { DRIVER_SEND_MS, FAILURES_BEFORE_WARNING, LocationPublisher, ageNow, getDriverLocation, publishDriverLocation, trackDriver, type Fix } from './tracking'

const fix = (lat: number): Fix => ({ position: { lat, lng: 151 }, accuracyM: 5, speedMps: 8 })

beforeEach(() => actions.call.mockReset())

describe('rider side', () => {
  it('maps the server row and keeps ageing locally', async () => {
    actions.call.mockResolvedValueOnce([{ lat: 1, lng: 2, accuracy_m: 6, speed_mps: 9, age_ms: 3000, trip_status: 'en_route' }])
    const loc = await getDriverLocation('r1')
    expect(actions.call).toHaveBeenCalledWith('get_driver_location', { request_id: 'r1' })
    expect(loc).toMatchObject({ position: { lat: 1, lng: 2 }, accuracyM: 6, speedMps: 9, ageMs: 3000, tripStatus: 'en_route' })
    expect(ageNow({ ageMs: 3000, receivedAt: 1000 }, 6000)).toBe(8000)
    expect(ageNow({ ageMs: 3000, receivedAt: 1000 }, 500)).toBe(3000) // a clock that went backwards never makes it younger
    actions.call.mockResolvedValueOnce([])
    expect(await getDriverLocation('r1')).toBeNull()
  })

  it('polls until aborted, reports nothing-yet as null, and survives a failed poll', async () => {
    const controller = new AbortController()
    const seen: unknown[] = []
    let errors = 0
    actions.call
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ lat: 1, lng: 2, accuracy_m: null, speed_mps: null, age_ms: 0, trip_status: 'arrived' }])
    await trackDriver('r1', {
      signal: controller.signal,
      onUpdate: (l) => {
        seen.push(l)
        if (seen.length === 2) controller.abort()
      },
      onError: () => { errors += 1 },
      sleep: async () => undefined,
    })
    expect(seen[0]).toBeNull()
    expect(seen[1]).toMatchObject({ tripStatus: 'arrived' })
    expect(errors).toBe(1)
    expect(actions.call).toHaveBeenCalledTimes(3)
  })

  it('does nothing when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await trackDriver('r1', { signal: controller.signal, onUpdate: vi.fn() })
    expect(actions.call).not.toHaveBeenCalled()
  })
})

describe('driver side', () => {
  it('sends the action with the trip ids', async () => {
    await publishDriverLocation('rider', 't1', fix(1))
    expect(actions.call).toHaveBeenCalledWith('publish_driver_location', { rider_id: 'rider', trip_id: 't1', lat: 1, lng: 151, accuracy_m: 5, speed_mps: 8 })
  })
})

describe('LocationPublisher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const make = (send: (f: Fix) => Promise<unknown>, onHealth = vi.fn()) => ({ pub: new LocationPublisher(send, onHealth, DRIVER_SEND_MS, Date.now), onHealth })

  it('sends the first fix at once and then at most one per interval, always the newest', async () => {
    const send = vi.fn(async () => undefined)
    const { pub } = make(send)
    pub.push(fix(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    for (let i = 2; i <= 6; i++) pub.push(fix(i)) // a burst of GPS fixes
    await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS - 1)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(fix(6)) // intermediate fixes are dropped, not queued
    await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS * 5)
    expect(send).toHaveBeenCalledTimes(2) // nothing new, nothing sent
  })

  it('reports ok after a success and warns only after repeated failures, recovering afterwards', async () => {
    let fail = true
    const send = vi.fn(async () => { if (fail) throw new Error('offline') })
    const { pub, onHealth } = make(send)
    for (let i = 0; i < FAILURES_BEFORE_WARNING; i++) {
      pub.push(fix(i))
      await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS)
      if (i < FAILURES_BEFORE_WARNING - 1) expect(onHealth).not.toHaveBeenCalled() // a blip is not a warning
    }
    expect(onHealth).toHaveBeenLastCalledWith('failing')
    fail = false
    pub.push(fix(9))
    await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS)
    expect(onHealth).toHaveBeenLastCalledWith('ok')
    expect(pub.health).toBe('ok')
  })

  it('never sends after it is stopped (the trip ended)', async () => {
    const send = vi.fn(async () => undefined)
    const { pub } = make(send)
    pub.push(fix(1))
    pub.stop()
    await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS * 3)
    pub.push(fix(2))
    await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS * 3)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not overlap sends while one is still in flight', async () => {
    let release: () => void = () => undefined
    const send = vi.fn(() => new Promise<void>((r) => { release = r }))
    const { pub } = make(send)
    pub.push(fix(1))
    await vi.advanceTimersByTimeAsync(0)
    pub.push(fix(2))
    await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS * 2)
    expect(send).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(DRIVER_SEND_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(fix(2))
  })
})
