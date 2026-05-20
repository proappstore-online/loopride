import { useEffect, useMemo, useState } from 'react'
import type { LatLng, RecurringRide, View } from '../types'
import { DAYS } from '../types'
import { getRide } from '../storage'
import { openTransport, type DriverPing, type TransportKind } from '../lib/transport'
import { encodeShareUrl } from '../lib/share'
import { interpolate } from '../lib/geo'
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
  const [transportKind, setTransportKind] = useState<TransportKind | null>(null)
  const [copied, setCopied] = useState(false)
  const [, setNow] = useState(Date.now())

  useEffect(() => {
    setRide(getRide(rideId))
  }, [rideId])

  useEffect(() => {
    const transport = openTransport(rideId)
    setTransportKind(transport.kind)
    const unsub = transport.subscribe((ping) => {
      setLastPing(ping)
      if (ping.status === 'en-route') setStatus((s) => (s === 'scheduled' ? 'en-route' : s))
      if (ping.status === 'arrived') setStatus('arrived')
      if (ping.status === 'completed') setStatus('completed')
    })
    return () => {
      unsub()
      transport.close()
    }
  }, [rideId])

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
    // Real-feed positions win even when stale — last-known location is more
    // useful than a fake interpolation that snaps the dot back to pickup.
    if (lastPing) return lastPing.position
    if (status === 'scheduled') return null
    if (status === 'completed') return null
    if (status === 'arrived') return ride.dropoffCoord
    return interpolate(ride.pickupCoord, ride.dropoffCoord, (TOTAL_ETA - eta) / TOTAL_ETA)
  }, [ride, status, eta, lastPing])

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
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={async () => {
              const url = encodeShareUrl(ride)
              try {
                await navigator.clipboard.writeText(url)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              } catch {
                window.prompt('Copy this link and send to your driver:', url)
              }
            }}
            className="rounded-xl border border-[var(--line)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]"
          >
            {copied ? 'Copied!' : 'Send to driver'}
          </button>
          <span className="text-[10px] text-[var(--muted)]">
            Driver opens the link → ride imports → they drive.
          </span>
        </div>
      </section>

      <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Status</p>
          {liveFeed ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--success)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--success)]" />
              Live · {lastPingAge}s ago
            </span>
          ) : lastPing ? (
            <span
              className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--error)]"
              title="Live feed has gone quiet. Showing last known driver position."
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--error)]" />
              Last seen {lastPingAge}s ago
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
        {transportKind === 'rooms'
          ? 'Live tracking is cross-device via FAS rooms.'
          : 'Live tracking is same-browser only. Sign in to enable cross-device.'}
      </p>
    </div>
  )
}
