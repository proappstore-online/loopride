import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import type { LatLng, RecurringRide } from '../types'
import { DAYS } from '../types'
import { getRide, saveRide } from '../storage'
import { openTransport, type DriverPing, type TransportKind } from '../lib/transport'
import { interpolate } from '../lib/geo'
import { LIVE_FEED_TIMEOUT_MS } from '../lib/constants'

const TripMap = lazy(() => import('./TripMap'))
const TOTAL_ETA = 8

interface TripProps {
  rideId: string
}

type TripStatus = 'scheduled' | 'matching' | 'en-route' | 'arrived' | 'completed'

export default function Trip({ rideId }: TripProps) {
  const [, setLocation] = useLocation()
  const [ride, setRide] = useState<RecurringRide | undefined>(undefined)
  const [status, setStatus] = useState<TripStatus>('matching')
  const [eta, setEta] = useState<number>(TOTAL_ETA)
  const [lastPing, setLastPing] = useState<DriverPing | null>(null)
  const [transportKind, setTransportKind] = useState<TransportKind | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const savedRide = getRide(rideId)
    setRide(savedRide)
    if (savedRide) {
      setEta(savedRide.etaMinutes ?? TOTAL_ETA)
      setStatus(savedRide.status ?? (savedRide.bookingType === 'now' ? 'en-route' : 'scheduled'))
    }
  }, [rideId])

  useEffect(() => {
    const transport = openTransport(rideId)
    setTransportKind(transport.kind)
    const unsub = transport.subscribe((ping) => {
      setLastPing(ping)
      if (ping.status === 'en-route') setStatus('en-route')
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

  const liveFeed = lastPing !== null && now - lastPing.at < LIVE_FEED_TIMEOUT_MS

  const driverPosition = useMemo<LatLng | null>(() => {
    if (!ride?.pickupCoord || !ride.dropoffCoord) return null
    // Real-feed positions win even when stale — last-known location is more
    // useful than a fake interpolation that snaps the dot back to pickup.
    if (lastPing) return lastPing.position
    if (status === 'scheduled' || status === 'matching') return null
    if (status === 'completed') return null
    if (status === 'arrived') return ride.dropoffCoord
    return interpolate(ride.pickupCoord, ride.dropoffCoord, (TOTAL_ETA - eta) / TOTAL_ETA)
  }, [ride, status, eta, lastPing])

  if (!ride) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <button
          onClick={() => setLocation('/')}
          className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)]"
        >
          ← Back
        </button>
        <p className="mt-8 text-center text-sm text-[var(--muted)]">Ride not found.</p>
      </div>
    )
  }

  const lastPingAge = lastPing ? Math.round((now - lastPing.at) / 1000) : null

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-baseline gap-4">
        <button
          onClick={() => setLocation('/')}
          className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        >
          ← Back
        </button>
        <h1 className="text-xl font-extrabold tracking-[-0.05em] text-[var(--ink)]">
          {ride.bookingType === 'recurring' ? 'Your routine' : ride.bookingType === 'scheduled' ? 'Reserved ride' : 'Your ride'}
        </h1>
      </header>

      <section className="mb-4">
        <Suspense
          fallback={
            <div className="flex h-72 items-center justify-center rounded-3xl border border-[var(--line)] bg-[var(--accent-soft)] text-xs text-[var(--muted)]">
              Loading map…
            </div>
          }
        >
          <TripMap
            pickup={ride.pickupCoord}
            dropoff={ride.dropoffCoord}
            driver={driverPosition}
            routePolyline={ride.routePolyline}
            onRouteFetched={(coords) => saveRide({ ...ride, routePolyline: coords })}
          />
        </Suspense>
      </section>

      <section className="rounded-3xl border border-[var(--line)] p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Route</p>
        <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
          {ride.pickup} → {ride.dropoff}
        </p>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{ride.bookingType === 'recurring' ? 'Routine' : 'Ride option'}</p>
        <p className="mt-1 text-sm text-[var(--ink)]">
          {ride.bookingType === 'recurring'
            ? `${DAYS.filter((d) => ride.days.includes(d.id)).map((d) => d.label).join(', ')} at ${ride.time}`
            : `${ride.vehicle === 'xl' ? 'RideShare XL' : ride.vehicle === 'comfort' ? 'Comfort' : 'RideShare'}${ride.fareCents ? ` · $${(ride.fareCents / 100).toFixed(2)}` : ''}`}
        </p>
        {ride.driverName && <div className="mt-4 flex items-center gap-3 rounded-2xl bg-[var(--accent-soft)] px-4 py-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--accent)] text-sm font-bold text-white">{ride.driverName.slice(0, 1)}</span><span><span className="block text-sm font-bold text-[var(--ink)]">{ride.driverName}</span><span className="block text-xs text-[var(--muted)]">★ {ride.driverRating ?? 4.9} · {ride.driverPlate ?? 'Matching vehicle'}</span></span><button className="ml-auto text-sm text-[var(--accent)]" aria-label="Call driver">☎</button></div>}
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
          {status === 'matching' && 'Finding a nearby driver'}
          {status === 'scheduled' && `Reserved for ${ride.scheduledFor ? new Date(ride.scheduledFor).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ride.time}`}
          {status === 'en-route' && (liveFeed ? `${ride.driverName || 'Your driver'} is on the way` : `${ride.driverName || 'Your driver'} arrives in ${eta} min`)}
          {status === 'arrived' && `${ride.driverName || 'Your driver'} has arrived`}
          {status === 'completed' && 'Trip completed'}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {(status === 'scheduled' || status === 'matching') && (
            <button
              onClick={() => {
                setStatus('en-route')
                setEta(TOTAL_ETA)
              }}
              className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
            >
              Preview driver arrival
            </button>
          )}
          {status === 'en-route' && !liveFeed && (
            <button
              onClick={() => setStatus('arrived')}
              className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]"
            >
              Driver arrived
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
              onClick={() => setLocation('/')}
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
