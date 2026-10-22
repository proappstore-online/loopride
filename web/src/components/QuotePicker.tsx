import { useEffect, useMemo, useState } from 'react'
import type { LatLng, RecurringRide, VehicleType } from '../types'
import { VEHICLES } from '../types'
import { firstMatch } from '../lib/maps'
import { fetchRoute } from '../lib/routing'
import { accountBlocked, SAFETY_COPY } from '../lib/safety'
import { acceptQuote, dispatchPaused, isEligible, PAUSED_TEXT, isExpired, REASON_TEXT, requestQuotes, secondsLeft, surgeLabel, type Quote, type QuoteRoute } from '../lib/quotes'

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
const km = (m: number) => `${(m / 1000).toFixed(1)} km`
const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} min`
const countdown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

interface Props {
  pickup: string
  pickupCoord: LatLng | null
  dropoff: string
  dropoffCoord: LatLng | null
  onAccepted: (ride: RecurringRide) => void
}

/**
 * Steps 2 and 3 of an on-demand request: price the route for every tier, show
 * eligibility and the fare breakdown with a live expiry countdown, then request
 * the chosen tier. Changing either address discards the quotes.
 */
export default function QuotePicker({ pickup, pickupCoord, dropoff, dropoffCoord, onAccepted }: Props) {
  const [route, setRoute] = useState<(QuoteRoute & { polyline?: [number, number][] }) | null>(null)
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [selected, setSelected] = useState<VehicleType | null>(null)
  const [busy, setBusy] = useState<'quoting' | 'requesting' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    let live = true
    void dispatchPaused().then((p) => live && setPaused(p))
    return () => {
      live = false
    }
  }, [])

  // Any change to the trip invalidates what was quoted.
  const tripKey = `${pickup.trim()}|${dropoff.trim()}|${pickupCoord?.lat},${pickupCoord?.lng}|${dropoffCoord?.lat},${dropoffCoord?.lng}`
  useEffect(() => {
    setRoute(null)
    setQuotes([])
    setSelected(null)
    setError(null)
  }, [tripKey])

  useEffect(() => {
    if (quotes.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [quotes.length])

  const ready = Boolean(pickup.trim() && dropoff.trim())
  const chosen = useMemo(() => quotes.find((q) => q.vehicle === selected) ?? null, [quotes, selected])
  const chosenExpired = chosen ? isExpired(chosen, now) : false
  const allExpired = quotes.length > 0 && quotes.every((q) => isExpired(q, now))

  const getQuotes = async () => {
    if (!ready || busy) return
    setBusy('quoting')
    setError(null)
    setSelected(null)
    try {
      const [from, to] = await Promise.all([pickupCoord ?? firstMatch(pickup.trim()), dropoffCoord ?? firstMatch(dropoff.trim())])
      if (!from || !to) throw new Error("We couldn't find one of those addresses. Pick a suggestion or be more specific.")
      const r = await fetchRoute(from, to)
      const trip: QuoteRoute = { pickup: { label: pickup.trim(), coord: from }, dropoff: { label: dropoff.trim(), coord: to }, distanceMeters: r.distanceMeters, durationSeconds: r.durationSeconds }
      setRoute({ ...trip, polyline: r.coordinates })
      const fresh = await requestQuotes(trip)
      setQuotes(fresh)
      setNow(Date.now())
      const firstAvailable = fresh.find(isEligible)
      if (firstAvailable) setSelected(firstAvailable.vehicle)
      else if (fresh.length > 0) setError('No drivers are available nearby right now. Try again in a moment.')
    } catch (reason) {
      setQuotes([])
      setError(reason instanceof Error ? reason.message : 'We could not price this trip')
    } finally {
      setBusy(null)
    }
  }

  const request = async () => {
    if (!chosen || !route || busy) return
    setBusy('requesting')
    setError(null)
    const rideId = crypto.randomUUID()
    const ride: RecurringRide = {
      id: rideId,
      pickup: route.pickup.label,
      pickupCoord: route.pickup.coord,
      dropoff: route.dropoff.label,
      dropoffCoord: route.dropoff.coord,
      days: [],
      time: new Date().toTimeString().slice(0, 5),
      driverName: '',
      paused: false,
      createdAt: Date.now(),
      requestedAt: Date.now(),
      bookingType: 'now',
      vehicle: chosen.vehicle,
      fareCents: chosen.totalCents,
      etaMinutes: Math.max(3, Math.round(route.durationSeconds / 60)),
      routePolyline: route.polyline,
      quoteId: chosen.id,
    }
    try {
      const result = await acceptQuote(chosen, route, rideId, ride)
      if (result.ok) return onAccepted(ride)
      const nowPaused = await dispatchPaused()
      setPaused(nowPaused)
      const restricted = !nowPaused && (await accountBlocked())
      setError(nowPaused ? PAUSED_TEXT : restricted ? SAFETY_COPY.blocked : REASON_TEXT[result.reason])
      setQuotes((current) => current.filter((q) => q.id !== chosen.id).map((q) => ({ ...q, expiresAt: result.reason === 'expired' ? 0 : q.expiresAt })))
      setSelected(null)
    } catch {
      setError("We couldn't request your ride. Check your connection and get new quotes.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Quotes" className="space-y-4">
      {paused && <p role="status" className="rounded-xl bg-[var(--accent-soft)] px-4 py-3 text-xs font-semibold text-[var(--ink)]">{PAUSED_TEXT}</p>}
      <button type="button" onClick={getQuotes} disabled={!ready || busy !== null || paused} className="w-full rounded-2xl bg-[var(--ink)] px-5 py-4 text-sm font-extrabold text-white disabled:opacity-40">
        {busy === 'quoting' ? 'Getting quotes…' : quotes.length > 0 ? 'Refresh quotes' : 'Get quotes'}
      </button>

      {route && (
        <p data-testid="route-summary" className="text-center text-xs font-semibold text-[var(--muted)]">
          {km(route.distanceMeters)} · about {mins(route.durationSeconds)}
        </p>
      )}

      {quotes.length > 0 && (
        <ul className="space-y-2" role="radiogroup" aria-label="Choose a ride">
          {VEHICLES.map((v) => {
            const quote = quotes.find((q) => q.vehicle === v.id)
            if (!quote) return null
            const eligible = isEligible(quote)
            const expired = isExpired(quote, now)
            const disabled = !eligible || expired
            const surge = surgeLabel(quote.surgeMilli)
            return (
              <li key={v.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected === v.id}
                  aria-label={`${v.label} ${usd(quote.totalCents)}`}
                  disabled={disabled}
                  onClick={() => setSelected(v.id)}
                  className={`w-full rounded-2xl border p-4 text-left transition disabled:opacity-50 ${selected === v.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-[var(--paper)]'}`}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-extrabold text-[var(--ink)]">{v.label}</span>
                    <span className="text-sm font-extrabold text-[var(--ink)]">{usd(quote.totalCents)}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--muted)]">{v.description}</span>
                  <span className={`mt-1 block text-xs font-semibold ${eligible ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                    {eligible ? `${quote.nearbyDrivers} ${quote.nearbyDrivers === 1 ? 'driver' : 'drivers'} nearby` : 'No drivers nearby for this option'}
                  </span>
                  <span className="mt-2 block space-y-0.5 text-[11px] text-[var(--muted)]">
                    <FareLine label="Base fare" cents={quote.baseCents} />
                    <FareLine label={`Distance (${km(quote.distanceM)})`} cents={quote.distanceCents} />
                    <FareLine label={`Time (${mins(quote.durationS)})`} cents={quote.timeCents} />
                    <FareLine label="Booking fee" cents={quote.bookingFeeCents} />
                    {quote.minAdjustCents > 0 && <FareLine label="Minimum fare adjustment" cents={quote.minAdjustCents} />}
                    {surge && <span className="flex justify-between font-semibold text-[var(--error)]"><span>High demand</span><span>{surge}</span></span>}
                  </span>
                  <span className="mt-2 block text-[11px] font-semibold text-[var(--muted)]">{expired ? 'Quote expired' : `Price held for ${countdown(secondsLeft(quote, now))}`}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {error && <p role="alert" className="rounded-xl bg-[#fff0ee] px-4 py-3 text-xs font-semibold text-[var(--error)]">{error}</p>}
      {allExpired && !error && <p role="alert" className="rounded-xl bg-[#fff0ee] px-4 py-3 text-xs font-semibold text-[var(--error)]">Your quotes expired. Refresh to see current prices.</p>}

      {quotes.length > 0 && (
        <button type="button" onClick={request} disabled={!chosen || chosenExpired || !isEligible(chosen) || busy !== null || paused} className="w-full rounded-2xl bg-[var(--accent)] px-5 py-4 text-sm font-extrabold text-white shadow-sm disabled:opacity-40">
          {busy === 'requesting' ? 'Requesting…' : chosen ? `Request ${VEHICLES.find((v) => v.id === chosen.vehicle)!.label} · ${usd(chosen.totalCents)}` : 'Choose a ride'}
        </button>
      )}
      <p className="text-center text-[11px] leading-4 text-[var(--muted)]">Prices are held for 5 minutes. If your route or local demand changes, you'll need a new quote.</p>
    </section>
  )
}

function FareLine({ label, cents }: { label: string; cents: number }) {
  return <span className="flex justify-between"><span>{label}</span><span>{`$${(cents / 100).toFixed(2)}`}</span></span>
}
