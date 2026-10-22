import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import type { LatLng, RecurringRide } from '../types'
import { DAYS } from '../types'
import { getRide, saveRide } from '../storage'
import { ageNow, trackDriver, type DriverLocation } from '../lib/tracking'
import { computeEta, etaTarget, etaTrusted, formatEta, freshness, locationSummary, shouldRecompute, type Eta } from '../lib/eta'
import { runDispatch, startDispatch, type DispatchStatus } from '../lib/dispatch'
import {
  OUTCOME_TEXT,
  RIDER_CANCEL_REASONS,
  RIDER_DISPUTE_REASONS,
  canReportDriverNoShow,
  canRiderCancel,
  cancelRide,
  currentUserId,
  isFinished,
  loadRiderTrip,
  openDispute,
  previewCancellation,
  reportDriverNoShow,
  type TripState,
} from '../lib/tripLifecycle'
import { showToast } from '../lib/toast'
import { loadReceipt, type Receipt } from '../lib/receipts'
import ReceiptCard from '../components/ReceiptCard'
import { reportError } from '../lib/telemetry'
import { canReportSafety } from '../lib/safety'
import SafetyPanel from '../components/SafetyPanel'
import MapAlternative from '../components/MapAlternative'

const TripMap = lazy(() => import('./TripMap'))

interface TripProps {
  rideId: string
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
const POLL_MS = 5000

/**
 * Rider's view of a ride. Rides requested through a server quote (`quoteId`)
 * are driven entirely by server state: dispatch, then the trip lifecycle set by
 * the assigned driver. Other rides (scheduled, routines, older records) are
 * shown as saved; there is nothing to simulate.
 */
export default function Trip({ rideId }: TripProps) {
  const [, setLocation] = useLocation()
  const [ride, setRide] = useState<RecurringRide | undefined>(undefined)
  const [loc, setLoc] = useState<DriverLocation | null>(null)
  const [eta, setEta] = useState<Eta | null>(null)
  const lastEta = useRef<{ from: { lat: number; lng: number }; target: { lat: number; lng: number }; at: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [dispatch, setDispatch] = useState<DispatchStatus | null>(null)
  const [trip, setTrip] = useState<TripState | null>(null)
  const [searchRun, setSearchRun] = useState(0)
  const [panel, setPanel] = useState<'cancel' | 'dispute' | 'safety' | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const managed = Boolean(ride?.quoteId)

  useEffect(() => {
    setRide(getRide(rideId))
  }, [rideId])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const refreshTrip = useCallback(
    () =>
      loadRiderTrip(rideId).then(
        (t) => {
          setTrip(t)
          return t
        },
        () => undefined,
      ),
    [rideId],
  )

  // Drive dispatch until it settles, then follow the trip the driver advances.
  useEffect(() => {
    if (!managed) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    runDispatch(rideId, { signal: controller.signal, onUpdate: setDispatch })
      .then(() => {
        if (controller.signal.aborted) return
        void refreshTrip()
        timer = setInterval(refreshTrip, POLL_MS)
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
      if (timer) clearInterval(timer)
    }
  }, [managed, rideId, searchRun, refreshTrip])

  const phase = trip?.phase ?? null
  const finished = phase !== null && isFinished(phase)
  // The statement is written in the transaction that ends the trip; read it once the trip is over.
  useEffect(() => {
    if (!managed || !finished) return
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    // The statement is written in the transaction that ends the trip, so it should be there at once.
    // If it is not, try once more, then raise an alert: a finished trip with no receipt is a payments bug.
    const attempt = (last: boolean) =>
      loadReceipt(rideId).then(
        (r) => {
          if (!live) return
          if (r) return setReceipt(r)
          if (!last) retry = setTimeout(() => attempt(true), 3000)
          else reportError({ domain: 'payment', code: 'receipt_missing', severity: 'error', tripId: `${rideId}:trip`, requestId: rideId })
        },
        () => undefined,
      )
    void attempt(false)
    return () => {
      live = false
      if (retry) clearTimeout(retry)
    }
  }, [managed, finished, rideId, trip?.cancelFeeCents])
  const tracking = managed && (phase === 'en_route' || phase === 'arrived' || phase === 'in_progress')

  // Live location comes from authenticated server polling, so it works across devices.
  useEffect(() => {
    if (!tracking) {
      setLoc(null)
      return
    }
    const controller = new AbortController()
    void trackDriver(rideId, { signal: controller.signal, onUpdate: setLoc })
    return () => controller.abort()
  }, [tracking, rideId])

  const age = loc ? ageNow(loc, now) : null
  const fresh = age === null ? null : freshness(age)
  const trusted = fresh !== null && etaTrusted(fresh)
  const target = phase ? etaTarget(phase, ride?.pickupCoord ?? null, ride?.dropoffCoord ?? null) : null

  // ETA from the driver's current position along current route data, refreshed as they move.
  const here = loc?.position
  const tick = Math.floor(now / 10_000)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!trusted || !here || !target) return
    if (!shouldRecompute(lastEta.current, here, target, Date.now())) return
    lastEta.current = { from: here, target, at: Date.now() }
    // Not cancelled when the next poll lands: the answer is still the newest one asked for.
    computeEta(here, target).then((e) => alive.current && setEta(e), () => undefined)
  }, [trusted, here, target, tick])

  useEffect(() => {
    if (!tracking) {
      setEta(null)
      lastEta.current = null
    }
  }, [tracking])

  const driverPosition = useMemo<LatLng | null>(() => (loc && fresh !== 'offline' ? loc.position : null), [loc, fresh])

  if (!ride) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <button onClick={() => setLocation('/')} className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)]">← Back</button>
        <p className="mt-8 text-center text-sm text-[var(--muted)]">Ride not found.</p>
      </div>
    )
  }

  const driverLabel = dispatch?.driverName || 'Your driver'
  const ageSec = age === null ? null : Math.round(age / 1000)
  const searching = managed && !trip && (dispatch === null || dispatch.state === 'searching')
  const cancellable = managed && ((trip && canRiderCancel(trip.phase)) || searching)

  const etaText = !loc ? 'Waiting for your driver’s location…' : !trusted ? 'ETA paused: the driver’s location is out of date.' : eta ? `${eta.approximate ? 'About ' : ''}${formatEta(eta.seconds)}${phase === 'in_progress' ? ' to your destination' : ' until pickup'}${eta.approximate ? ' (approximate)' : ''}` : 'Calculating ETA…'

  const headline = (() => {
    if (!managed) {
      if (ride.bookingType === 'scheduled') return `Reserved for ${ride.scheduledFor ? new Date(ride.scheduledFor).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ride.time}`
      if (ride.bookingType === 'recurring') return 'Routine saved'
      return ride.status === 'completed' ? 'Trip completed' : 'Ride saved on this device'
    }
    if (trip) {
      if (trip.phase === 'cancelled') return trip.outcome ? OUTCOME_TEXT[trip.outcome] : 'Ride cancelled'
      if (trip.phase === 'completed') return 'Trip completed'
      if (trip.phase === 'in_progress') return 'On your way'
      if (trip.phase === 'arrived') return `${driverLabel} has arrived`
      if (trip.phase === 'en_route') return `${driverLabel} is on the way`
      return `${driverLabel} accepted and is getting ready`
    }
    if (dispatch?.state === 'no_driver') return 'No drivers are available right now'
    if (dispatch?.state === 'cancelled') return 'Ride cancelled'
    return dispatch?.offerStatus === 'offered' ? 'Waiting for a driver to confirm' : 'Finding a nearby driver'
  })()

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-baseline gap-4">
        <button onClick={() => setLocation('/')} className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]">← Back</button>
        <h1 className="text-xl font-extrabold tracking-[-0.05em] text-[var(--ink)]">
          {ride.bookingType === 'recurring' ? 'Your routine' : ride.bookingType === 'scheduled' ? 'Reserved ride' : 'Your ride'}
        </h1>
      </header>

      <section className="mb-4">
        <Suspense fallback={<div className="flex h-72 items-center justify-center rounded-3xl border border-[var(--line)] bg-[var(--accent-soft)] text-xs text-[var(--muted)]">Loading map…</div>}>
          <TripMap label={`Map of the route from ${ride.pickup} to ${ride.dropoff}. The same details are listed below as text.`} pickup={ride.pickupCoord} dropoff={ride.dropoffCoord} driver={driverPosition} approach={trusted && eta?.polyline ? eta.polyline : undefined} routePolyline={ride.routePolyline} onRouteFetched={(coords) => saveRide({ ...ride, routePolyline: coords })} />
        </Suspense>
      </section>

      <MapAlternative
        rows={[
          { label: 'Pickup', value: ride.pickup },
          { label: 'Drop-off', value: ride.dropoff },
          ...(managed
            ? [
                { label: 'Driver', value: dispatch?.driverName ? `${dispatch.driverName}${dispatch.plate ? `, ${dispatch.plate}` : ''}` : 'Not assigned yet' },
                ...(tracking ? [{ label: 'Driver location', value: locationSummary(fresh, ageSec) }, ...(phase !== 'arrived' ? [{ label: 'ETA', value: etaText }] : [])] : []),
              ]
            : []),
        ]}
      />

      <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Route</p>
        <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{ride.pickup} → {ride.dropoff}</p>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{ride.bookingType === 'recurring' ? 'Routine' : 'Ride option'}</p>
        <p className="mt-1 text-sm text-[var(--ink)]">
          {ride.bookingType === 'recurring'
            ? `${DAYS.filter((d) => ride.days.includes(d.id)).map((d) => d.label).join(', ')} at ${ride.time}`
            : `${ride.vehicle === 'xl' ? 'RideShare XL' : ride.vehicle === 'comfort' ? 'Comfort' : 'RideShare'}${ride.fareCents ? ` · ${usd(ride.fareCents)}` : ''}`}
        </p>
        {managed && dispatch?.driverName && (
          <div className="mt-4 flex items-center gap-3 rounded-2xl bg-[var(--accent-soft)] px-4 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--accent)] text-sm font-bold text-white">{dispatch.driverName.slice(0, 1)}</span>
            <span><span className="block text-sm font-bold text-[var(--ink)]">{dispatch.driverName}</span><span className="block text-xs text-[var(--muted)]">{dispatch.plate ?? 'Matching vehicle'}</span></span>
          </div>
        )}
      </section>

      <section className="mt-4 rounded-3xl border border-[var(--line)] p-6">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Status</p>
          {tracking && <FreshnessBadge state={fresh} ageSec={ageSec} />}
        </div>
        <p aria-live="polite" className="mt-1 display-font text-2xl font-semibold text-[var(--ink)]">{headline}</p>
        {tracking && phase !== 'arrived' && (
          <p role="status" aria-label="ETA" className="mt-2 text-sm font-semibold text-[var(--ink)]">
            {etaText}
          </p>
        )}
        {trip && trip.phase === 'cancelled' && (
          <p className="mt-2 text-sm text-[var(--muted)]">
            {trip.cancelFeeCents > 0 ? `Cancellation fee: ${usd(trip.cancelFeeCents)}` : 'No cancellation fee.'}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {managed && !trip && dispatch?.state === 'no_driver' && (
            <button onClick={() => startDispatch(rideId).then(() => setSearchRun((n) => n + 1), () => undefined)} className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white">Search again</button>
          )}
          {cancellable && panel !== 'cancel' && (
            <button onClick={() => setPanel('cancel')} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Cancel ride</button>
          )}
          {trip && canReportDriverNoShow(trip, now) && (
            <button
              onClick={() =>
                reportDriverNoShow(rideId).then(
                  () =>
                    refreshTrip().then((after) => {
                      if (after && !isFinished(after.phase)) reportError({ domain: 'transition', code: 'step_refused', severity: 'warn', action: 'report_driver_no_show', tripId: after.tripId, requestId: rideId, detail: `still ${after.phase}` })
                    }),
                  () => showToast({ message: "Couldn't send that report" }),
                )
              }
              className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--error)]"
            >
              Driver hasn't arrived
            </button>
          )}
          {trip && canReportSafety(trip, now) && panel !== 'safety' && (
            <button onClick={() => setPanel('safety')} className="rounded-2xl border border-[var(--error)] px-5 py-2 text-sm font-semibold text-[var(--error)]">Safety</button>
          )}
          {trip && isFinished(trip.phase) && !trip.disputed && panel !== 'dispute' && (
            <button onClick={() => setPanel('dispute')} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Report a problem</button>
          )}
          {trip?.disputed && <span className="self-center text-xs font-semibold text-[var(--muted)]">Problem reported. Support will review it.</span>}
          {(!managed || (trip && isFinished(trip.phase))) && (
            <button onClick={() => setLocation('/')} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Back to rides</button>
          )}
        </div>

        {panel === 'cancel' && (
          <CancelPanel
            rideId={rideId}
            onClose={() => setPanel(null)}
            onDone={() => {
              setPanel(null)
              setDispatch((d) => (d ? { ...d, state: 'cancelled' } : d))
              const before = trip
              void refreshTrip().then((after) => {
                // Cancelling was offered, so a trip that is still open afterwards means the server refused a legal step.
                if (before && canRiderCancel(before.phase) && after && !isFinished(after.phase))
                  reportError({ domain: 'transition', code: 'step_rejected', severity: 'error', action: 'cancel_ride', tripId: before.tripId, requestId: rideId, detail: `expected cancelled, got ${after.phase}` })
              })
            }}
          />
        )}
        {panel === 'safety' && trip && <SafetyPanel riderId={currentUserId() ?? ''} tripId={trip.tripId} role="rider" onClose={() => setPanel(null)} />}
        {panel === 'dispute' && trip && (
          <DisputePanel
            tripId={trip.tripId}
            onClose={() => setPanel(null)}
            onDone={() => {
              setPanel(null)
              void refreshTrip()
            }}
          />
        )}
      </section>

      {receipt && <div className="mt-4"><ReceiptCard receipt={receipt} /></div>}

      {managed && <p className="mt-6 text-center text-xs text-[var(--muted)]">Your driver's location is shared only while they are on the way or driving you, and is deleted when the trip ends.</p>}
    </div>
  )
}

function CancelPanel({ rideId, onClose, onDone }: { rideId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<string>(RIDER_CANCEL_REASONS[0].code)
  const [fee, setFee] = useState<{ feeCents: number; policy: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    previewCancellation(rideId).then(setFee, () => setFee({ feeCents: 0, policy: 'none' }))
  }, [rideId])

  const confirm = async () => {
    setBusy(true)
    try {
      await cancelRide(rideId, reason)
      onDone()
    } catch {
      showToast({ message: "Couldn't cancel the ride" })
      setBusy(false)
    }
  }

  return (
    <div role="group" aria-label="Cancel ride" className="mt-4 space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <label className="block text-xs font-bold text-[var(--ink)]">Why are you cancelling?
        <select className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)}>
          {RIDER_CANCEL_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      <p role="status" className="text-xs font-semibold text-[var(--ink)]">
        {fee === null ? 'Checking the cancellation fee…' : fee.feeCents > 0 ? `A ${usd(fee.feeCents)} cancellation fee applies.` : 'Free to cancel.'}
      </p>
      <div className="flex gap-2">
        <button onClick={confirm} disabled={busy || fee === null} className="rounded-2xl bg-[var(--error)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">Confirm cancellation</button>
        <button onClick={onClose} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Keep ride</button>
      </div>
    </div>
  )
}

function DisputePanel({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<string>(RIDER_DISPUTE_REASONS[0].code)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    try {
      await openDispute(currentUserId() ?? '', tripId, reason, note)
      onDone()
    } catch {
      showToast({ message: "Couldn't send your report" })
      setBusy(false)
    }
  }
  return (
    <div role="group" aria-label="Report a problem" className="mt-4 space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <label className="block text-xs font-bold text-[var(--ink)]">What went wrong?
        <select className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)}>
          {RIDER_DISPUTE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      <label className="block text-xs font-bold text-[var(--ink)]">Details (optional)
        <textarea className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <button onClick={send} disabled={busy} className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">Send report</button>
        <button onClick={onClose} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Close</button>
      </div>
    </div>
  )
}

function FreshnessBadge({ state, ageSec }: { state: ReturnType<typeof freshness> | null; ageSec: number | null }) {
  if (state === 'live') return <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--success)]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--success)]" />Live · {ageSec}s ago</span>
  if (state === 'delayed') return <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)]" />Delayed · {ageSec}s ago</span>
  if (state === 'stale') return <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--error)]" title="Showing the last known driver position."><span className="h-1.5 w-1.5 rounded-full bg-[var(--error)]" />Last seen {Math.max(1, Math.round((ageSec ?? 0) / 60))} min ago</span>
  if (state === 'offline') return <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--error)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--error)]" />Driver offline</span>
  return <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">No live location yet</span>
}
