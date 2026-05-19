import { app } from './app'
import { publish as bcPublish, subscribe as bcSubscribe, type DriverPing } from './channel'

export type { DriverPing }

export type TransportKind = 'rooms' | 'broadcast'

export interface Transport {
  kind: TransportKind
  publish: (ping: DriverPing) => void
  subscribe: (cb: (ping: DriverPing) => void) => () => void
  close: () => void
}

/**
 * Pick the best available transport for a ride.
 *
 * - Signed in → FAS rooms (cross-device WebSocket via Durable Object).
 * - Anonymous → BroadcastChannel (same browser only).
 *
 * Transport is locked at open time; signing in mid-trip doesn't switch.
 */
export function openTransport(rideId: string): Transport {
  if (app.auth.token) {
    const room = app.rooms.join(rideId)
    return {
      kind: 'rooms',
      publish: (ping) => room.send(ping),
      subscribe: (cb) =>
        room.onMessage<DriverPing>((msg) => {
          if (msg.data && msg.data.rideId === rideId) cb(msg.data)
        }),
      close: () => room.close(),
    }
  }

  const unsubs = new Set<() => void>()
  return {
    kind: 'broadcast',
    publish: (ping) => bcPublish(ping),
    subscribe: (cb) => {
      const unsub = bcSubscribe(rideId, cb)
      unsubs.add(unsub)
      return () => {
        unsub()
        unsubs.delete(unsub)
      }
    },
    close: () => {
      for (const u of unsubs) u()
      unsubs.clear()
    },
  }
}
