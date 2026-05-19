import { useEffect, useMemo, useState } from 'react'
import type { LatLng, RecurringRide, View } from '../types'
import { DAYS } from '../types'
import { getRide } from '../storage'
import { subscribe, type DriverPing } from '../lib/channel'
import TripMap from './TripMap'

const TOTAL_ETA = 8
const REAL_FEED_TIMEOUT_MS = 15_000

interface TripProps {
  rideId: string
  onNavigate: (view: View) => void
}

type TripStatus = 'scheduled' | 'en-route' | 'arrived' | 'completed'

export default function Trip({ rideId, onNavigate }: TripProps) {
  const [ride, setRide] = useState<RecurringRide | undefined>(undefined)
  const [status, setStatus] = useState<TripStatus>('scheduled')
  const [eta, setEta] = useState<number>(TOTAL_ETA)
  const [lastPing, setLastPing] = useState<DriverPing | null>(null)
  const [, setNow] = useState(Date.now())

  useEffect(() => {
    setRide(getRide(rideId))
  }, [rideId])

  useEffect(() => {
    const unsub = subscribe(rideId, (ping) => {
      setLastPing(ping)
      if (ping.status === 'en-route' && status === 'scheduled') setStatus('en-route')
      if (ping.status === 'arrived') setStatus('arrived')
      if (ping.status === 'completed') setStatus('completed')
    })
    return unsub
  }, [rideId, status])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (status !== 'en-route' || lastPing) return
    const t = setInterval(() => setEta((m) => Math.max(0, m - 1)), 3000)
    return () => clearInterval(t)
  }, [status, lastPing])

  useEffect(() => {
    if (status === 'en-route' && eta === 0 && !lastPing) setStatus('arrived')
  }, [status, eta, lastPing])

  const liveFeed = lastPing !== null && Date.now() - lastPing.at < REAL_FEED_TIMEOUT_MS

  const driverPosition = useMemo<LatLng | null>(() => {
    if (!ride?.pickupCoord || !ride.dropoffCoord) return null
    if (liveFeed && lastPing) return lastPing.position
    if (status === 'scheduled') return null
    if (status === 'completed') return null
    if (status === 'arrived') return ride.dropoffCoord
    const progress = (TOTAL_ETA - eta) / TOTAL_ETA
    const t = Math.max(0, Math.min(1, progress))
    return {
      lat: ride.pickupCoord.lat + (ride.dropoffCoord.lat - ride.pickupCoord.lat) * t,
      lng: ride.pickupCoord.lng + (ride.dropoffCoord.lng - ride.pickupCoord.lng) * t,
    }
  }, [ride, status, eta, lastPing, liveFeed])

  if (!ride) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <button
          onClick={() => onNavigate({ name: 'home' })}
          className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)]"
        >
          ← Back
        </button>
        <p className="mt-8 text-center text-sm text-[var(--muted)]">Ride not found.</p>
      </div>
    )
  }

  const lastPingAge = lastPing ? Math.round((Date.now() - lastPing.at) / 1000) : null

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-baseline gap-4">
        <button
          onClick={() => onNavigate({ name: 'home' })}
          className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        >
          ← Back
        </button>
        <h1 className="display-font text-2xl font-bold text-[var(--ink)]">Next trip</h1>
      </header>

      <section className="mb-4">
        <TripMap
          pickup={ride.pickupCoord}
          dropoff={ride.dropoffCoord}
          driver={driverPosition}
        />
      </section>

      <section className="rounded-3xl border border-[var(--line)] p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Route</p>
        <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
          {ride.pickup} → {ride.dropoff}
        </p>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          Schedule
        </p>
        <p className="mt-1 text-sm text-[var(--ink)]">
          {DAYS.filter((d) => ride.days.includes(d.id))
            .map((d) => d.label)
            .join(', ')}{' '}
          at <span className="tabular-nums">{ride.time}</span> with {ride.driverName}
        </p>
      </section>

      <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Status</p>
          {liveFeed ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--success)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--success)]" />
              Live · {lastPingAge}s ago
            </span>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              No live feed
            </span>
          )}
        </div>
        <p className="mt-1 display-font text-2xl font-semibold text-[var(--ink)]">
          {status === 'scheduled' && 'Scheduled'}
          {status === 'en-route' && (liveFeed ? 'Driver en route' : `Driver en route · ${eta} min`)}
          {status === 'arrived' && 'Driver has arrived'}
          {status === 'completed' && 'Trip completed'}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {status === 'scheduled' && (
            <button
              onClick={() => {
                setStatus('en-route')
                setEta(TOTAL_ETA)
              }}
              className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
            >
              Simulate: driver on way
            </button>
          )}
          {status === 'en-route' && !liveFeed && (
            <button
              onClick={() => setStatus('arrived')}
              className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]"
            >
              Mark arrived
            </button>
          )}
          {status === 'arrived' && !liveFeed && (
            <button
              onClick={() => setStatus('completed')}
              className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
            >
              Trip complete
            </button>
          )}
          {status === 'completed' && (
            <button
              onClick={() => onNavigate({ name: 'home' })}
              className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]"
            >
              Back to rides
            </button>
          )}
        </div>
      </section>

      <p className="mt-6 text-center text-xs text-[var(--muted)]">
        Open the Driver tab in another tab to drive this trip and see the dot move live.
      </p>
    </div>
  )
}
