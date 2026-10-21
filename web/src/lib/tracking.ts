import { app } from './app'
import type { LatLng } from '../types'

/**
 * Live tracking over authenticated server actions (no browser-local or
 * unauthenticated channel). The assigned driver publishes at most every few
 * seconds; the rider polls. Rules (phases, throttle, precision, retention,
 * visibility) are enforced by the actions in mcp.json; see
 * docs/domain-model.md › Live tracking.
 */
export interface DriverLocation {
  position: LatLng
  accuracyM: number | null
  speedMps: number | null
  tripStatus: 'en_route' | 'arrived'
  /** Age at the moment the server answered, by the server's clock. */
  ageMs: number
  /** Local time the answer arrived, so the age can keep growing without trusting the device clock for the original timestamp. */
  receivedAt: number
}

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

export const ageNow = (loc: Pick<DriverLocation, 'ageMs' | 'receivedAt'>, now = Date.now()) => loc.ageMs + Math.max(0, now - loc.receivedAt)

export async function getDriverLocation(requestId: string): Promise<DriverLocation | null> {
  const [row] = await call<{ lat: number; lng: number; accuracy_m: number | null; speed_mps: number | null; age_ms: number; trip_status: 'en_route' | 'arrived' }[]>('get_driver_location', { request_id: requestId })
  if (!row) return null
  return { position: { lat: row.lat, lng: row.lng }, accuracyM: row.accuracy_m, speedMps: row.speed_mps, tripStatus: row.trip_status, ageMs: row.age_ms, receivedAt: Date.now() }
}

export const RIDER_POLL_MS = 4000

/** Poll until aborted. A failed poll keeps the last known location (it just ages). */
export async function trackDriver(
  requestId: string,
  opts: { signal: AbortSignal; onUpdate: (loc: DriverLocation | null) => void; onError?: () => void; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  while (!opts.signal.aborted) {
    try {
      const loc = await getDriverLocation(requestId)
      if (opts.signal.aborted) return
      opts.onUpdate(loc)
    } catch {
      if (opts.signal.aborted) return
      opts.onError?.()
    }
    await sleep(opts.intervalMs ?? RIDER_POLL_MS)
  }
}

// ---- driver ----
export interface Fix {
  position: LatLng
  accuracyM: number | null
  speedMps: number | null
}

export type PublishHealth = 'waiting' | 'ok' | 'failing'

export const DRIVER_SEND_MS = 4000
export const FAILURES_BEFORE_WARNING = 3

/**
 * Throttles a stream of GPS fixes to one authenticated update per interval,
 * always sending the newest fix and never queueing old ones, and reports
 * whether updates are actually reaching the server.
 */
export class LocationPublisher {
  private latest: Fix | null = null
  private lastSentAt = -Infinity
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false
  private failures = 0
  private stopped = false
  health: PublishHealth = 'waiting'

  private readonly send: (fix: Fix) => Promise<unknown>
  private readonly onHealth: (h: PublishHealth) => void
  private readonly intervalMs: number
  private readonly now: () => number

  constructor(send: (fix: Fix) => Promise<unknown>, onHealth: (h: PublishHealth) => void = () => undefined, intervalMs = DRIVER_SEND_MS, now: () => number = Date.now) {
    this.send = send
    this.onHealth = onHealth
    this.intervalMs = intervalMs
    this.now = now
  }

  push(fix: Fix): void {
    if (this.stopped) return
    this.latest = fix
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.latest = null
  }

  private schedule(): void {
    if (this.timer || this.inFlight) return
    const wait = Math.max(0, this.lastSentAt + this.intervalMs - this.now())
    this.timer = setTimeout(() => void this.flush(), wait)
  }

  private async flush(): Promise<void> {
    this.timer = null
    const fix = this.latest
    if (!fix || this.stopped) return
    this.latest = null
    this.inFlight = true
    this.lastSentAt = this.now()
    try {
      await this.send(fix)
      this.failures = 0
      this.set('ok')
    } catch {
      this.failures += 1
      if (this.failures >= FAILURES_BEFORE_WARNING) this.set('failing')
    } finally {
      this.inFlight = false
      if (this.latest) this.schedule()
    }
  }

  private set(h: PublishHealth): void {
    if (this.health === h) return
    this.health = h
    this.onHealth(h)
  }
}

export const publishDriverLocation = (riderId: string, tripId: string, fix: Fix) =>
  call('publish_driver_location', { rider_id: riderId, trip_id: tripId, lat: fix.position.lat, lng: fix.position.lng, accuracy_m: fix.accuracyM, speed_mps: fix.speedMps })
