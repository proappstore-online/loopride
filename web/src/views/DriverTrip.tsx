import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import type { LatLng } from '../types'
import { useWakeLock } from '../lib/useWakeLock'
import { LocationPublisher, publishDriverLocation, type PublishHealth } from '../lib/tracking'
import { showToast } from '../lib/toast'
import {
  DRIVER_CANCEL_REASONS,
  DRIVER_DISPUTE_REASONS,
  OUTCOME_TEXT,
  canReportRiderNoShow,
  driverCancel,
  driverStep,
  isFinished,
  loadDriverTrip,
  type Phase,
  nextDriverStep,
  noShowWaitLeftMs,
  openDispute,
  reportRiderNoShow,
} from '../lib/tripLifecycle'
import { loadEarnings, money, type Earning } from '../lib/receipts'
import { reportError } from '../lib/telemetry'
import LocationConsent from '../components/LocationConsent'
import { useLocationConsent } from '../lib/useLocationConsent'
import { canReportSafety } from '../lib/safety'
import SafetyPanel from '../components/SafetyPanel'
import MapAlternative from '../components/MapAlternative'

const TripMap = lazy(() => import('./TripMap'))

interface Props {
  riderId: string
  rideId: string
}

type DriverTripState = NonNullable<Awaited<ReturnType<typeof loadDriverTrip>>>

const POLL_MS = 5000
const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

/**
 * The assigned driver's trip. Every button calls a server action that checks
 * the driver owns the trip and that the step is valid; the screen only shows
 * the next legal step and re-reads the server's state after each one.
 */
export default function DriverTrip({ riderId, rideId }: Props) {
  const [, setLocation] = useLocation()
  const tripId = `${rideId}:trip`
  const [trip, setTrip] = useState<DriverTripState | null | undefined>(undefined)
  const [panel, setPanel] = useState<'cancel' | 'dispute' | 'safety' | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [position, setPosition] = useState<LatLng | null>(null)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [health, setHealth] = useState<PublishHealth>('waiting')
  const [earning, setEarning] = useState<Earning | null>(null)

  const refresh = useCallback(
    () =>
      loadDriverTrip(riderId, tripId).then(
        (t) => {
          setTrip(t)
          return t
        },
        () => {
          setTrip((t) => t ?? null)
          return undefined
        },
      ),
    [riderId, tripId],
  )
  useEffect(() => {
    void refresh()
    const poll = setInterval(refresh, POLL_MS)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [refresh])

  const phase = trip?.phase ?? null
  const finished = phase !== null && isFinished(phase)
  useEffect(() => {
    if (!finished) return
    let live = true
    loadEarnings().then((rows) => live && setEarning(rows.find((e) => e.tripId === tripId) ?? null), () => undefined)
    return () => {
      live = false
    }
  }, [finished, tripId])
  const driving = phase === 'en_route' || phase === 'arrived' || phase === 'in_progress'
  useWakeLock(driving)
  const consent = useLocationConsent('trip_tracking')
  const sharing = driving && consent.state === 'granted'

  // Real GPS only, sent as authenticated, throttled updates, and only while the trip is
  // in a phase where the server will accept them and the driver has agreed to share. Sharing
  // stops the moment the trip ends or the agreement is withdrawn.
  useEffect(() => {
    if (!sharing) return
    if (!('geolocation' in navigator)) {
      setGeoError('Location is not available on this device')
      return
    }
    const publisher = new LocationPublisher((fix) => publishDriverLocation(riderId, tripId, fix), (h) => {
      setHealth(h)
      if (h === 'failing') reportError({ domain: 'tracking', code: 'publish_failing', severity: 'error', tripId, requestId: rideId })
    })
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setPosition(here)
        setGeoError(null)
        publisher.push({ position: here, accuracyM: pos.coords.accuracy ?? null, speedMps: pos.coords.speed ?? null })
      },
      (err) => {
        setGeoError(err.message)
        reportError({ domain: 'tracking', code: 'location_unavailable', severity: 'warn', tripId, requestId: rideId, detail: err.message })
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10_000 },
    )
    return () => {
      navigator.geolocation.clearWatch(watch)
      publisher.stop()
      setHealth('waiting')
    }
  }, [sharing, riderId, tripId, rideId])

  /**
   * Run one trip action and confirm the server did it. The screen only offers legal steps, so a
   * step that leaves the trip where it was is a real problem worth an alert (unless someone else
   * already ended the trip, which is only a warning).
   */
  const act = async (run: () => Promise<unknown>, failure: string, action: string, expected: Phase) => {
    setBusy(true)
    try {
      await run()
      const after = await refresh()
      if (after && after.phase !== expected) {
        const ended = isFinished(after.phase)
        reportError({ domain: 'transition', code: ended ? 'step_superseded' : 'step_rejected', severity: ended ? 'warn' : 'error', action, tripId, requestId: rideId, detail: `expected ${expected}, got ${after.phase}` })
      }
    } catch {
      showToast({ message: failure })
    } finally {
      setBusy(false)
    }
  }

  if (trip === undefined) return null
  if (trip === null) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <button onClick={() => setLocation('/driver')} className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)]">← Back</button>
        <p className="mt-8 text-center text-sm text-[var(--muted)]">Trip not found, or it isn't assigned to you.</p>
      </div>
    )
  }

  const step = phase ? nextDriverStep(phase) : null
  const noShowLeft = noShowWaitLeftMs(trip, now)

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-baseline gap-4">
        <button onClick={() => setLocation('/driver')} className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]">← Back</button>
        <h1 className="text-xl font-extrabold tracking-[-0.05em] text-[var(--ink)]">RideShare Drive</h1>
      </header>

      <section className="mb-4">
        <Suspense fallback={<div className="flex h-72 items-center justify-center rounded-3xl border border-[var(--line)] bg-[var(--accent-soft)] text-xs text-[var(--muted)]">Loading map…</div>}>
          <TripMap label={`Map of the trip from ${trip.pickup} to ${trip.dropoff}. The same details are listed below as text.`} pickup={trip.pickupCoord} dropoff={trip.dropoffCoord} driver={driving ? position : null} />
        </Suspense>
      </section>

      <MapAlternative
        rows={[
          { label: 'Pickup', value: trip.pickup ?? 'Not available' },
          { label: 'Drop-off', value: trip.dropoff ?? 'Not available' },
          ...(driving ? [{ label: 'Your location', value: sharing ? (position ? 'Being shared with the rider' : 'Waiting for a location fix') : 'Not being shared' }] : []),
        ]}
      />

      <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Trip</p>
        <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{trip.pickup} → {trip.dropoff}</p>
        {driving && consent.state === 'not_granted' && (
          <div className="mt-3">
            <LocationConsent purpose="trip_tracking" state={consent.state} failed={consent.failed} onGrant={consent.grant} onWithdraw={consent.withdraw} />
            <p role="status" className="mt-2 text-xs font-semibold text-[var(--error)]">Location sharing is off. The rider can't see you.</p>
          </div>
        )}
        {sharing && (
          <p role="status" className={`mt-2 text-xs ${health === 'failing' || geoError ? 'font-semibold text-[var(--error)]' : 'text-[var(--muted)]'}`}>
            {geoError
              ? `Location: ${geoError}. The rider can't see you.`
              : health === 'failing'
                ? "Your location isn't reaching the rider. Check your connection."
                : position
                  ? 'Sharing your live location with the rider until the trip ends'
                  : 'Waiting for a location fix…'}
          </p>
        )}
        {sharing && (
          <button onClick={consent.withdraw} className="mt-2 rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-bold text-[var(--ink)]">Stop sharing</button>
        )}
      </section>

      <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Status</p>
        <p aria-live="polite" className="mt-1 display-font text-2xl font-semibold text-[var(--ink)]">
          {phase === 'scheduled' && 'Accepted. Head to the pickup when ready'}
          {phase === 'en_route' && 'Driving to pickup'}
          {phase === 'arrived' && 'At pickup. Waiting for the rider'}
          {phase === 'in_progress' && 'Trip in progress'}
          {phase === 'completed' && 'Trip completed'}
          {phase === 'cancelled' && (trip.outcome ? OUTCOME_TEXT[trip.outcome].replace('You cancelled', 'The rider cancelled') : 'Trip cancelled')}
        </p>

        {earning && (
          <p role="status" aria-label="Earnings" className="mt-2 text-sm font-semibold text-[var(--ink)]">
            {earning.payoutCents > 0 ? `Earned ${money(earning.payoutCents)} for this trip (accrued; payouts are not enabled yet)` : 'No earnings for this trip'}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {step && (
            <button disabled={busy} onClick={() => act(() => driverStep(step.run, riderId, tripId), "That step isn't available right now", step.run === 'start' ? 'start_trip' : 'advance_trip', step.run === 'start' ? 'in_progress' : step.run)} className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">{step.label}</button>
          )}
          {phase === 'arrived' && (
            <button
              disabled={busy || !canReportRiderNoShow(trip, now)}
              onClick={() => act(() => reportRiderNoShow(riderId, tripId), "Couldn't report the no-show", 'report_rider_no_show', 'cancelled')}
              className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-50"
            >
              {canReportRiderNoShow(trip, now) ? "Rider didn't show" : `Rider no-show in ${mmss(noShowLeft)}`}
            </button>
          )}
          {(phase === 'scheduled' || phase === 'en_route' || phase === 'arrived') && panel !== 'cancel' && (
            <button onClick={() => setPanel('cancel')} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--error)]">Cancel trip</button>
          )}
          {canReportSafety(trip, now) && panel !== 'safety' && (
            <button onClick={() => setPanel('safety')} className="rounded-2xl border border-[var(--error)] px-5 py-2 text-sm font-semibold text-[var(--error)]">Safety</button>
          )}
          {phase && isFinished(phase) && !trip.disputed && panel !== 'dispute' && (
            <button onClick={() => setPanel('dispute')} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Report a problem</button>
          )}
          {trip.disputed && <span className="self-center text-xs font-semibold text-[var(--muted)]">Problem reported. Support will review it.</span>}
          {phase && isFinished(phase) && (
            <button onClick={() => setLocation('/driver')} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Back to requests</button>
          )}
        </div>

        {panel === 'cancel' && (
          <ReasonPanel
            label="Cancel trip"
            question="Why are you cancelling?"
            reasons={DRIVER_CANCEL_REASONS}
            confirm="Confirm cancellation"
            note="The rider is not charged. Repeated cancellations are reviewed."
            onClose={() => setPanel(null)}
            onSubmit={async (code, text) => {
              setPanel(null)
              await act(() => driverCancel(riderId, tripId, code, text), "Couldn't cancel the trip", 'driver_cancel_trip', 'cancelled')
            }}
          />
        )}
        {panel === 'safety' && <SafetyPanel riderId={riderId} tripId={tripId} role="driver" onClose={() => setPanel(null)} />}
        {panel === 'dispute' && (
          <ReasonPanel
            label="Report a problem"
            question="What went wrong?"
            reasons={DRIVER_DISPUTE_REASONS}
            confirm="Send report"
            onClose={() => setPanel(null)}
            onSubmit={async (code, text) => {
              setPanel(null)
              await act(() => openDispute(riderId, tripId, code, text), "Couldn't send your report", 'open_dispute', phase ?? 'completed')
            }}
          />
        )}
      </section>
    </div>
  )
}

function ReasonPanel({ label, question, reasons, confirm, note, onClose, onSubmit }: {
  label: string
  question: string
  reasons: readonly { code: string; label: string }[]
  confirm: string
  note?: string
  onClose: () => void
  onSubmit: (code: string, text: string) => void
}) {
  const [code, setCode] = useState(reasons[0].code)
  const [text, setText] = useState('')
  return (
    <div role="group" aria-label={label} className="mt-4 space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <label className="block text-xs font-bold text-[var(--ink)]">{question}
        <select className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" value={code} onChange={(e) => setCode(e.target.value)}>
          {reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      <label className="block text-xs font-bold text-[var(--ink)]">Details (optional)
        <textarea className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" rows={2} maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {note && <p className="text-xs text-[var(--muted)]">{note}</p>}
      <div className="flex gap-2">
        <button onClick={() => onSubmit(code, text)} className="rounded-2xl bg-[var(--error)] px-5 py-2 text-sm font-semibold text-white">{confirm}</button>
        <button onClick={onClose} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Close</button>
      </div>
    </div>
  )
}
