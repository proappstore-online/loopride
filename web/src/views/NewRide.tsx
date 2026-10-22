import { useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import type { DayOfWeek, LatLng, RecurringRide, VehicleType } from '../types'
import { DAYS, VEHICLES } from '../types'
import { saveRide } from '../storage'
import { firstMatch } from '../lib/maps'
import { fetchRoute } from '../lib/routing'
import { LIMITS } from '../lib/constants'
import { useAuth } from '../lib/useAuth'
import { app } from '../lib/app'
import QuotePicker from '../components/QuotePicker'
import AddressInput from '../components/AddressInput'

type BookingMode = 'now' | 'scheduled' | 'recurring'

function initialMode(location: string): BookingMode {
  if (location.includes('when=repeat')) return 'recurring'
  if (location.includes('when=later')) return 'scheduled'
  return 'now'
}

export default function NewRide() {
  const [location, setLocation] = useLocation()
  const auth = useAuth()
  const [mode, setMode] = useState<BookingMode>(() => initialMode(typeof window === 'undefined' ? location : window.location.search))
  const [pickup, setPickup] = useState('')
  const [pickupCoord, setPickupCoord] = useState<LatLng | null>(null)
  const [dropoff, setDropoff] = useState('')
  const [dropoffCoord, setDropoffCoord] = useState<LatLng | null>(null)
  const [vehicle, setVehicle] = useState<VehicleType>('share')
  const [days, setDays] = useState<DayOfWeek[]>(['mon', 'tue', 'wed', 'thu', 'fri'])
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))
  const [time, setTime] = useState('08:00')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedVehicle = useMemo(() => VEHICLES.find((item) => item.id === vehicle)!, [vehicle])
  const estimate = Math.round(1180 * selectedVehicle.multiplier)
  // On-demand rides use server quotes and real dispatch, so they need an account. Reservations and routines work signed out.
  const live = mode === 'now' && Boolean(auth.user)
  const valid = pickup.trim() && dropoff.trim() && (mode !== 'recurring' || days.length > 0)

  const toggleDay = (day: DayOfWeek) => setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day])
  const ensureCoord = (query: string, picked: LatLng | null) => picked ?? firstMatch(query)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || saving || mode === 'now') return
    setSaving(true)
    setError(null)
    try {
      const cleanPickup = pickup.trim().slice(0, LIMITS.pickupChars)
      const cleanDropoff = dropoff.trim().slice(0, LIMITS.dropoffChars)
      const [resolvedPickup, resolvedDropoff] = await Promise.all([ensureCoord(cleanPickup, pickupCoord), ensureCoord(cleanDropoff, dropoffCoord)])
      let routePolyline: [number, number][] | undefined
      if (resolvedPickup && resolvedDropoff) {
        try {
          routePolyline = (await fetchRoute(resolvedPickup, resolvedDropoff)).coordinates
        } catch { /* a usable booking can still be saved without a cached route */ }
      }
      const ride: RecurringRide = {
        id: crypto.randomUUID(), pickup: cleanPickup, pickupCoord: resolvedPickup,
        dropoff: cleanDropoff, dropoffCoord: resolvedDropoff,
        days: mode === 'recurring' ? days : [], time,
        driverName: '', paused: false, createdAt: Date.now(),
        requestedAt: Date.now(), bookingType: mode, vehicle, fareCents: estimate,
        scheduledFor: mode === 'scheduled' ? `${date}T${time}` : undefined, routePolyline,
      }
      saveRide(ride)
      setLocation('/')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'We could not request this ride')
      setSaving(false)
    }
  }

  const action = mode === 'scheduled' ? 'Reserve ride' : 'Save routine'

  return <div className="mx-auto min-h-[100dvh] max-w-2xl px-4 py-5 sm:px-6">
    <header className="mb-6 flex items-center gap-4"><button onClick={() => setLocation('/')} className="grid h-11 w-11 place-items-center rounded-full border border-[var(--line)] text-[var(--ink)] hover:bg-[var(--accent-soft)]" aria-label="Back to rides"><span aria-hidden="true">←</span></button><div><h1 className="text-xl font-extrabold tracking-[-0.05em] text-[var(--ink)]">Plan your ride</h1><p className="mt-0.5 text-xs text-[var(--muted)]">Choose a destination and we’ll do the matching.</p></div></header>
    <form onSubmit={submit} className="space-y-6">
      <div role="group" aria-label="When do you want to ride?" className="grid grid-cols-3 rounded-2xl bg-[var(--accent-soft)] p-1 text-xs font-bold text-[var(--ink)]">
        {([['now', 'Ride now'], ['scheduled', 'Later'], ['recurring', 'Routine']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={mode === id} onClick={() => setMode(id)} className={`rounded-xl px-2 py-2.5 transition ${mode === id ? 'bg-[var(--paper)] shadow-sm' : 'text-[var(--muted)]'}`}>{label}</button>)}
      </div>
      <section className="rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-[0_8px_35px_rgba(12,34,27,0.04)]">
        <p className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Trip details</p>
        <div className="space-y-4"><AddressInput label="Pickup" value={pickup} onChange={(value) => { setPickup(value); setPickupCoord(null) }} onSelect={(name, coord) => { setPickup(name); setPickupCoord(coord) }} placeholder="Enter pickup" maxLength={LIMITS.pickupChars} testIdPrefix="pickup" /><AddressInput label="Destination" value={dropoff} onChange={(value) => { setDropoff(value); setDropoffCoord(null) }} onSelect={(name, coord) => { setDropoff(name); setDropoffCoord(coord) }} placeholder="Where are you going?" maxLength={LIMITS.dropoffChars} testIdPrefix="dropoff" /></div>
      </section>

      {live && <QuotePicker pickup={pickup} pickupCoord={pickupCoord} dropoff={dropoff} dropoffCoord={dropoffCoord} onAccepted={(ride) => { saveRide(ride); setLocation(`/trip/${ride.id}`) }} />}
      {mode === 'now' && !auth.loading && !auth.user && (
        <section role="note" className="space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
          <p className="text-sm font-extrabold text-[var(--ink)]">Sign in to ride now</p>
          <p className="text-xs leading-5 text-[var(--ink)]">On-demand rides are matched with real nearby drivers and priced with a live quote, so they need an account. You can still reserve a ride for later or save a routine without signing in.</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => app.auth.signIn('google')} className="rounded-xl border border-[var(--line)] bg-white px-4 py-2 text-xs font-bold text-[var(--ink)]">Sign in with Google</button>
            <button type="button" onClick={() => app.auth.signIn('github')} className="rounded-xl border border-[var(--line)] bg-white px-4 py-2 text-xs font-bold text-[var(--ink)]">Sign in with GitHub</button>
          </div>
        </section>
      )}
      {mode === 'scheduled' && <section aria-labelledby="choose-ride"><p id="choose-ride" className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Choose a ride</p><div role="group" aria-labelledby="choose-ride" className="space-y-2">{VEHICLES.map((item) => <button type="button" key={item.id} aria-pressed={vehicle === item.id} onClick={() => setVehicle(item.id)} className={`flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition ${vehicle === item.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-[var(--paper)]'}`}><span className="grid h-10 w-12 place-items-center rounded-xl bg-[var(--ink)] text-xl text-white">{item.id === 'xl' ? '▰' : item.id === 'comfort' ? '◒' : '◐'}</span><span className="flex-1"><span className="block text-sm font-extrabold text-[var(--ink)]">{item.label}</span><span className="mt-0.5 block text-xs text-[var(--muted)]">{item.description}</span></span><span className="text-sm font-bold text-[var(--ink)]">${(1180 * item.multiplier / 100).toFixed(2)}</span></button>)}</div></section>}
      {mode === 'scheduled' && <section className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4"><p className="mb-3 text-sm font-extrabold text-[var(--ink)]">When should we pick you up?</p><div className="grid grid-cols-2 gap-3"><input aria-label="Pickup date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink)]" /><input aria-label="Pickup time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink)]" /></div></section>}
      {mode === 'recurring' && <section className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4"><p className="text-sm font-extrabold text-[var(--ink)]">Build a routine</p><p className="mt-1 text-xs text-[var(--muted)]">We’ll remind you to book when it’s time to leave.</p><div className="mt-4 flex flex-wrap gap-2">{DAYS.map((day) => <button type="button" key={day.id} aria-pressed={days.includes(day.id)} onClick={() => toggleDay(day.id)} className={`rounded-xl border px-3 py-2 text-xs font-bold ${days.includes(day.id) ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)] text-[var(--ink)]'}`}>{day.label}</button>)}</div><input aria-label="Routine time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink)]" /></section>}
      {error && <p role="alert" className="rounded-xl bg-[#fff0ee] px-4 py-3 text-xs font-semibold text-[var(--error)]">{error}</p>}
      {mode !== 'now' && <button type="submit" disabled={!valid || saving} className="w-full rounded-2xl bg-[var(--accent)] px-5 py-4 text-sm font-extrabold text-white shadow-sm disabled:opacity-40">{saving ? 'Creating your ride…' : action}</button>}
      {mode !== 'now' && <p className="text-center text-[11px] leading-4 text-[var(--muted)]">Estimate shown before booking. Final fare may vary with route, demand, tolls, and wait time.</p>}
    </form>
  </div>
}
