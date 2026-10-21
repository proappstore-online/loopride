import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import type { LatLng, RecurringRide } from '../types'
import { DAYS } from '../types'
import { getRide, saveRide } from '../storage'
import { openTransport, type DriverPing, type TransportKind } from '../lib/transport'
import { LIVE_FEED_TIMEOUT_MS } from '../lib/constants'
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
  const [lastPing, setLastPing] = useState<DriverPing | null>(null)
  const [transportKind, setTransportKind] = useState<TransportKind | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [dispatch, setDispatch] = useState<DispatchStatus | null>(null)
  const [trip, setTrip] = useState<TripState | null>(null)
  const [searchRun, setSearchRun] = useState(0)
  const [panel, setPanel] = useState<'cancel' | 'dispute' | null>(null)
  const managed = Boolean(ride?.quoteId)

  useEffect(() => {
    setRide(getRide(rideId))
  }, [rideId])

  useEffect(() => {
    const transport = openTransport(rideId)
    setTransportKind(transport.kind)
    const unsub = transport.subscribe(setLastPing)
    return () => {
      unsub()
      transport.close()
    }
  }, [rideId])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const refreshTrip = useCallback(() => loadRiderTrip(rideId).then(setTrip, () => undefined), [rideId])

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

  const liveFeed = lastPing !== null && now - lastPing.at < LIVE_FEED_TIMEOUT_MS
  const phase = trip?.phase ?? null

  const driverPosition = useMemo<LatLng | null>(() => (lastPing && phase && !isFinished(phase) ? lastPing.position : null), [lastPing, phase])

  if (!ride) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <button onClick={() => setLocation('/')} className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)]">← Back</button>
        <p className="mt-8 text-center text-sm text-[var(--muted)]">Ride not found.</p>
      </div>
    )
  }

  const driverLabel = dispatch?.driverName || 'Your driver'
  const lastPingAge = lastPing ? Math.round((now - lastPing.at) / 1000) : null
  const searching = managed && !trip && (dispatch === null || dispatch.state === 'searching')
  const cancellable = managed && ((trip && canRiderCancel(trip.phase)) || searching)

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
          <TripMap pickup={ride.pickupCoord} dropoff={ride.dropoffCoord} driver={driverPosition} routePolyline={ride.routePolyline} onRouteFetched={(coords) => saveRide({ ...ride, routePolyline: coords })} />
        </Suspense>
      </section>

      <section className="rounded-3xl border border-[var(--line)] p-6">
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
          {managed && (liveFeed ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--success)]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--success)]" />Live · {lastPingAge}s ago</span>
          ) : lastPing ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--error)]" title="Live feed has gone quiet. Showing last known driver position."><span className="h-1.5 w-1.5 rounded-full bg-[var(--error)]" />Last seen {lastPingAge}s ago</span>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">No live feed</span>
          ))}
        </div>
        <p className="mt-1 display-font text-2xl font-semibold text-[var(--ink)]">{headline}</p>
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
              onClick={() => reportDriverNoShow(rideId).then(refreshTrip, () => showToast({ message: "Couldn't send that report" }))}
              className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--error)]"
            >
              Driver hasn't arrived
            </button>
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
              void refreshTrip()
            }}
          />
        )}
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

      {managed && (
        <p className="mt-6 text-center text-xs text-[var(--muted)]">
          {transportKind === 'rooms' ? 'Live tracking is cross-device via FAS rooms.' : 'Live tracking is same-browser only. Sign in to enable cross-device.'}
        </p>
      )}
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
