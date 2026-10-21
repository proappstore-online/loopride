import { beforeEach, describe, expect, it, vi } from 'vitest'

const { maps } = vi.hoisted(() => ({ maps: { geocode: vi.fn(), route: vi.fn() } }))
vi.mock('./app', () => ({ app: { maps } }))

import { firstMatch, geocode } from './maps'
import { fetchRoute } from './routing'
import { installTelemetry, resetTelemetry, takeMetrics } from './telemetry'

const capture = vi.fn()
const call = vi.fn(async () => undefined)
const events = () => call.mock.calls.filter((c) => (c as unknown[])[0] === 'report_client_event').map((c) => (c as unknown[])[1] as Record<string, unknown>)

beforeEach(() => {
  maps.geocode.mockReset()
  maps.route.mockReset()
  capture.mockReset()
  call.mockClear()
  resetTelemetry()
  installTelemetry({ actions: { call }, logs: { capture } })
})

describe('geocoding through the SDK (so the platform session is sent)', () => {
  it('returns matches and passes the abort signal on', async () => {
    maps.geocode.mockResolvedValue([{ lat: 1, lng: 2, displayName: 'A St', address: {}, type: 'x', importance: 1 }])
    const controller = new AbortController()
    expect(await geocode('A St', 3, { signal: controller.signal })).toEqual([{ lat: 1, lng: 2, displayName: 'A St' }])
    expect(maps.geocode).toHaveBeenCalledWith('A St', 3, { signal: controller.signal })
    expect(JSON.parse(takeMetrics()!)).toMatchObject([{ d: 'maps', c: 1, e: 0 }])
  })

  it('takes the best match, or null when there is none', async () => {
    maps.geocode.mockResolvedValueOnce([{ lat: 1, lng: 2, displayName: 'A' }, { lat: 3, lng: 4, displayName: 'B' }])
    expect(await firstMatch('A')).toEqual({ lat: 1, lng: 2 })
    maps.geocode.mockResolvedValueOnce([])
    expect(await firstMatch('nowhere')).toBeNull()
  })

  it('counts and reports a failure, and rethrows so the screen can say so', async () => {
    maps.geocode.mockRejectedValue(new Error('geocode 503'))
    await expect(geocode('A')).rejects.toThrow('geocode 503')
    expect(JSON.parse(takeMetrics()!)).toMatchObject([{ d: 'maps', c: 1, e: 1 }])
    expect(events()).toMatchObject([{ domain: 'maps', code: 'geocode_failed', severity: 'warn' }])
  })

  it('does not treat a cancelled request as an outage', async () => {
    maps.geocode.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await expect(geocode('A')).rejects.toThrow()
    expect(events()).toEqual([])
    expect(takeMetrics()).toBeNull()
  })
})

describe('routing through the SDK', () => {
  it('maps the route', async () => {
    maps.route.mockResolvedValue({ geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] }, distanceMeters: 1500, durationSeconds: 240 })
    expect(await fetchRoute({ lat: 0, lng: 0 }, { lat: 1, lng: 1 })).toEqual({ coordinates: [[1, 2], [3, 4]], distanceMeters: 1500, durationSeconds: 240 })
    expect(maps.route).toHaveBeenCalledWith({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }, undefined)
  })

  it('counts and reports a failure', async () => {
    maps.route.mockRejectedValue(new Error('route 500'))
    await expect(fetchRoute({ lat: 0, lng: 0 }, { lat: 1, lng: 1 })).rejects.toThrow('route 500')
    expect(events()).toMatchObject([{ domain: 'maps', code: 'route_failed' }])
  })
})
