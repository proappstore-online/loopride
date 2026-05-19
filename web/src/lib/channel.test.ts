import { describe, expect, it, vi } from 'vitest'
import { publish, subscribe, type DriverPing } from './channel'

const ping = (rideId: string, lat = 0, lng = 0): DriverPing => ({
  rideId,
  position: { lat, lng },
  speedMps: 12,
  accuracyM: 5,
  status: 'en-route',
  at: Date.now(),
})

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('channel', () => {
  it('subscriber receives pings for its rideId', async () => {
    const cb = vi.fn()
    const unsub = subscribe('ride-a', cb)
    publish(ping('ride-a', 1, 2))
    await flush()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ rideId: 'ride-a', position: { lat: 1, lng: 2 } })
    unsub()
  })

  it('subscriber ignores pings for other rideIds', async () => {
    const cb = vi.fn()
    const unsub = subscribe('ride-a', cb)
    publish(ping('ride-b'))
    await flush()
    expect(cb).not.toHaveBeenCalled()
    unsub()
  })

  it('unsubscribed callback stops receiving pings', async () => {
    const cb = vi.fn()
    const unsub = subscribe('ride-a', cb)
    unsub()
    publish(ping('ride-a'))
    await flush()
    expect(cb).not.toHaveBeenCalled()
  })
})
