import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { LatLng, RecurringRide, View } from '../types'
import { getRide } from '../storage'
import { useWakeLock } from '../lib/useWakeLock'
import { openTransport, type Transport, type TransportKind } from '../lib/transport'
import { interpolate } from '../lib/geo'

const TripMap = lazy(() => import('./TripMap'))

interface DriverTripProps {
  rideId: string
  onNavigate: (view: View) => void
}

type Phase = 'pre' | 'driving' | 'arrived' | 'done'

export default function DriverTrip({ rideId, onNavigate }: DriverTripProps) {
  const [ride, setRide] = useState<RecurringRide | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('pre')
  const [simStep, setSimStep] = useState(0)
  const [useSim, setUseSim] = useState(true)
  const [realPos, setRealPos] = useState<LatLng | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const [speed, setSpeed] = useState<number | null>(null)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [transportKind, setTransportKind] = useState<TransportKind | null>(null)
  const transportRef = useRef<Transport | null>(null)

  const wakeLock = useWakeLock(phase === 'driving')

  useEffect(() => {
    setRide(getRide(rideId))
  }, [rideId])

  const active = phase === 'driving' || phase === 'arrived'

  useEffect(() => {
    if (!active) return
    const t = openTransport(rideId)
    transportRef.current = t
    setTransportKind(t.kind)
    return () => {
      t.close()
      transportRef.current = null
    }
  }, [active, rideId])

  useEffect(() => {
    if (phase !== 'driving') return
    if (!('geolocation' in navigator)) {
      setGeoError('Geolocation API not available')
      return
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setRealPos({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setAccuracy(pos.coords.accuracy)
        setSpeed(pos.coords.speed)
        setGeoError(null)
      },
      (err) => setGeoError(err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10_000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [phase])

  const broadcastPos = useMemo<LatLng | null>(() => {
    if (!ride?.pickupCoord || !ride.dropoffCoord) return null
    if (useSim) return interpolate(ride.pickupCoord, ride.dropoffCoord, simStep)
    return realPos
  }, [ride, useSim, simStep, realPos])

  useEffect(() => {
    if (phase !== 'driving' || !broadcastPos) return
    transportRef.current?.publish({
      rideId,
      position: broadcastPos,
      speedMps: speed,
      accuracyM: accuracy,
      status: 'en-route',
      at: Date.now(),
    })
  }, [phase, broadcastPos, rideId, speed, accuracy])

  if (!ride) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <button
          onClick={() => onNavigate({ name: 'driver-home' })}
          className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)]"
        >
          ← Back
        </button>
        <p className="mt-8 text-center text-sm text-[var(--muted)]">Ride not found.</p>
      </div>
    )
  }

  const onStart = () => setPhase('driving')

  const onStep = () => {
    setUseSim(true)
    setSimStep((s) => Math.min(1, s + 0.1))
  }

  const onArrived = () => {
    if (ride.pickupCoord && ride.dropoffCoord) {
      transportRef.current?.publish({
        rideId,
        position: ride.dropoffCoord,
        speedMps: 0,
        accuracyM: accuracy,
        status: 'arrived',
        at: Date.now(),
      })
    }
    setSimStep(1)
    setPhase('arrived')
  }

  const onComplete = () => {
    if (ride.dropoffCoord) {
      transportRef.current?.publish({
        rideId,
        position: ride.dropoffCoord,
        speedMps: 0,
        accuracyM: accuracy,
        status: 'completed',
        at: Date.now(),
      })
    }
    setPhase('done')
    onNavigate({ name: 'driver-home' })
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-baseline gap-4">
        <button
          onClick={() => onNavigate({ name: 'driver-home' })}
          className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        >
          ← Back
        </button>
        <h1 className="display-font text-2xl font-bold text-[var(--ink)]">Driving</h1>
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
            driver={phase === 'driving' || phase === 'arrived' ? broadcastPos : null}
          />
        </Suspense>
      </section>

      <section className="rounded-3xl border border-[var(--line)] p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Trip</p>
        <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
          {ride.pickup} → {ride.dropoff}
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">Rider expects you at {ride.time}</p>
      </section>

      {phase !== 'pre' && (
        <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Broadcasting
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <dt className="text-[var(--muted)]">Wake lock</dt>
            <dd className="text-[var(--ink)]">
              {!wakeLock.supported
                ? 'unsupported by browser'
                : wakeLock.active
                  ? 'active — screen will stay on'
                  : wakeLock.error
                    ? `error: ${wakeLock.error}`
                    : 'idle'}
            </dd>
            <dt className="text-[var(--muted)]">GPS</dt>
            <dd className="text-[var(--ink)]">
              {geoError
                ? `error: ${geoError}`
                : realPos
                  ? `${realPos.lat.toFixed(5)}, ${realPos.lng.toFixed(5)}${
                      accuracy !== null ? ` ±${accuracy.toFixed(0)}m` : ''
                    }`
                  : 'waiting for fix…'}
            </dd>
            <dt className="text-[var(--muted)]">Speed</dt>
            <dd className="text-[var(--ink)]">
              {speed !== null ? `${(speed * 3.6).toFixed(0)} km/h` : '—'}
            </dd>
            <dt className="text-[var(--muted)]">Position source</dt>
            <dd className="text-[var(--ink)]">
              {useSim ? 'simulated along route' : 'real GPS'}
              <button
                onClick={() => setUseSim((s) => !s)}
                className="ml-2 rounded-md border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold"
              >
                switch to {useSim ? 'real' : 'sim'}
              </button>
            </dd>
          </dl>
        </section>
      )}

      <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Status</p>
        <p className="mt-1 display-font text-2xl font-semibold text-[var(--ink)]">
          {phase === 'pre' && 'Ready to drive'}
          {phase === 'driving' && `En route · ${Math.round(simStep * 100)}% of route`}
          {phase === 'arrived' && 'Arrived at pickup'}
          {phase === 'done' && 'Trip complete'}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {phase === 'pre' && (
            <button
              onClick={onStart}
              className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
            >
              Start trip
            </button>
          )}
          {phase === 'driving' && (
            <>
              <button
                onClick={onStep}
                className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]"
              >
                Step +10% (sim)
              </button>
              <button
                onClick={onArrived}
                className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
              >
                I've arrived
              </button>
            </>
          )}
          {phase === 'arrived' && (
            <button
              onClick={onComplete}
              className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
            >
              Trip complete
            </button>
          )}
        </div>
      </section>

      <p className="mt-6 text-center text-xs text-[var(--muted)]">
        {transportKind === 'rooms'
          ? 'Position broadcasts cross-device via FAS rooms.'
          : 'Position broadcasts cross-tab via BroadcastChannel. Sign in for cross-device.'}
      </p>
    </div>
  )
}
