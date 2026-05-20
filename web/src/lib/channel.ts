import type { LatLng } from '../types'
import { BROADCAST_CHANNEL } from './constants'

export interface DriverPing {
  rideId: string
  position: LatLng
  speedMps: number | null
  accuracyM: number | null
  status: 'en-route' | 'arrived' | 'completed'
  at: number
}

const CHANNEL = BROADCAST_CHANNEL

export function publish(ping: DriverPing): void {
  const ch = new BroadcastChannel(CHANNEL)
  try {
    ch.postMessage(ping)
  } finally {
    ch.close()
  }
}

export function subscribe(rideId: string, cb: (ping: DriverPing) => void): () => void {
  const ch = new BroadcastChannel(CHANNEL)
  const onMessage = (ev: MessageEvent<DriverPing>) => {
    if (ev.data && ev.data.rideId === rideId) cb(ev.data)
  }
  ch.addEventListener('message', onMessage)
  return () => {
    ch.removeEventListener('message', onMessage)
    ch.close()
  }
}
