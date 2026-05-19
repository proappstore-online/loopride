import { describe, expect, it, vi } from 'vitest'
import type { DriverPing } from './channel'

const { authState, room } = vi.hoisted(() => {
  const room = {
    send: vi.fn(),
    onMessage: vi.fn(() => () => undefined),
    close: vi.fn(),
  }
  return { authState: { token: null as string | null }, room }
})

vi.mock('./app', () => ({
  app: {
    auth: {
      get token() {
        return authState.token
      },
    },
    rooms: {
      join: vi.fn(() => room),
    },
  },
}))

import { openTransport } from './transport'
import { publish as bcPublish } from './channel'

const ping = (rideId: string): DriverPing => ({
  rideId,
  position: { lat: 1, lng: 2 },
  speedMps: 10,
  accuracyM: 5,
  status: 'en-route',
  at: Date.now(),
})

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('transport', () => {
  it('picks broadcast when not signed in', () => {
    authState.token = null
    const t = openTransport('r1')
    expect(t.kind).toBe('broadcast')
  })

  it('broadcast publish/subscribe round-trips for matching rideId', async () => {
    authState.token = null
    const cb = vi.fn()
    const t = openTransport('r1')
    t.subscribe(cb)
    bcPublish(ping('r1'))
    await flush()
    expect(cb).toHaveBeenCalledTimes(1)
    t.close()
  })

  it('broadcast subscribe ignores other rideIds', async () => {
    authState.token = null
    const cb = vi.fn()
    const t = openTransport('r1')
    t.subscribe(cb)
    bcPublish(ping('r2'))
    await flush()
    expect(cb).not.toHaveBeenCalled()
    t.close()
  })

  it('picks rooms when signed in', () => {
    authState.token = 'fake-jwt'
    const t = openTransport('r1')
    expect(t.kind).toBe('rooms')
  })

  it('rooms publish forwards to room.send', () => {
    authState.token = 'fake-jwt'
    const t = openTransport('r1')
    const p = ping('r1')
    t.publish(p)
    expect(room.send).toHaveBeenCalledWith(p)
  })

  it('rooms close calls room.close', () => {
    authState.token = 'fake-jwt'
    const t = openTransport('r1')
    t.close()
    expect(room.close).toHaveBeenCalled()
  })
})
