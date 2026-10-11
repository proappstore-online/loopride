import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import type { DayOfWeek, LatLng, RecurringRide, VehicleType } from '../types'
import { DAYS, VEHICLES } from '../types'
import { saveRide } from '../storage'
import { firstMatch, geocode } from '../lib/maps'
import { fetchRoute } from '../lib/routing'
import { LIMITS } from '../lib/constants'

interface GeoSuggestion { lat: number; lng: number; displayName: string; shortName: string }
type BookingMode = 'now' | 'scheduled' | 'recurring'

function shortNameFor(displayName: string): string {
  const parts = displayName.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1 && /^\d+[a-z]?$/i.test(parts[0])) return `${parts[0]} ${parts[1]}`
  return parts[0] || displayName
}

function initialMode(location: string): BookingMode {
  if (location.includes('when=repeat')) return 'recurring'
  if (location.includes('when=later')) return 'scheduled'
  return 'now'
}

export default function NewRide() {
  const [location, setLocation] = useLocation()
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
  const valid = pickup.trim() && dropoff.trim() && (mode !== 'recurring' || days.length > 0)

  const toggleDay = (day: DayOfWeek) => setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day])
  const ensureCoord = (query: string, picked: LatLng | null) => picked ?? firstMatch(query)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const cleanPickup = pickup.trim().slice(0, LIMITS.pickupChars)
      const cleanDropoff = dropoff.trim().slice(0, LIMITS.dropoffChars)
      const [resolvedPickup, resolvedDropoff] = await Promise.all([ensureCoord(cleanPickup, pickupCoord), ensureCoord(cleanDropoff, dropoffCoord)])
      let routePolyline: [number, number][] | undefined
      let etaMinutes = 6
      if (resolvedPickup && resolvedDropoff) {
        try {
          const route = await fetchRoute(resolvedPickup, resolvedDropoff)
          routePolyline = route.coordinates
          etaMinutes = Math.max(3, Math.round(route.durationSeconds / 60))
        } catch { /* a usable ride can still be requested without a cached route */ }
      }
      const immediate = mode === 'now'
      const ride: RecurringRide = {
        id: crypto.randomUUID(), pickup: cleanPickup, pickupCoord: resolvedPickup,
        dropoff: cleanDropoff, dropoffCoord: resolvedDropoff,
        days: mode === 'recurring' ? days : [], time,
        driverName: immediate ? 'Jordan' : '', paused: false, createdAt: Date.now(),
        requestedAt: Date.now(), bookingType: mode, vehicle, fareCents: estimate,
        etaMinutes: immediate ? etaMinutes : undefined,
        driverPlate: immediate ? 'RS-482' : undefined, driverRating: immediate ? 4.9 : undefined,
        scheduledFor: mode === 'scheduled' ? `${date}T${time}` : undefined, routePolyline,
      }
      saveRide(ride)
      setLocation(immediate ? `/trip/${ride.id}` : '/')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'We could not request this ride')
      setSaving(false)
    }
  }

  const action = mode === 'now' ? `Request ${selectedVehicle.label} · $${(estimate / 100).toFixed(2)}` : mode === 'scheduled' ? 'Reserve ride' : 'Save routine'

  return <div className="mx-auto min-h-[100dvh] max-w-2xl px-4 py-5 sm:px-6">
    <header className="mb-6 flex items-center gap-4"><button onClick={() => setLocation('/')} className="grid h-10 w-10 place-items-center rounded-full border border-[var(--line)] text-[var(--ink)] hover:bg-[var(--accent-soft)]" aria-label="Back">←</button><div><h1 className="text-xl font-extrabold tracking-[-0.05em] text-[var(--ink)]">Plan your ride</h1><p className="mt-0.5 text-xs text-[var(--muted)]">Choose a destination and we’ll do the matching.</p></div></header>
    <form onSubmit={submit} className="space-y-6">
      <div className="grid grid-cols-3 rounded-2xl bg-[var(--accent-soft)] p-1 text-xs font-bold text-[var(--ink)]">
        {([['now', 'Ride now'], ['scheduled', 'Later'], ['recurring', 'Routine']] as const).map(([id, label]) => <button type="button" key={id} onClick={() => setMode(id)} className={`rounded-xl px-2 py-2.5 transition ${mode === id ? 'bg-[var(--paper)] shadow-sm' : 'text-[var(--muted)]'}`}>{label}</button>)}
      </div>
      <section className="rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-[0_8px_35px_rgba(12,34,27,0.04)]">
        <p className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Trip details</p>
        <div className="space-y-4"><AddressInput label="Pickup" value={pickup} onChange={(value) => { setPickup(value); setPickupCoord(null) }} onSelect={(name, coord) => { setPickup(name); setPickupCoord(coord) }} placeholder="Enter pickup" maxLength={LIMITS.pickupChars} testIdPrefix="pickup" /><AddressInput label="Destination" value={dropoff} onChange={(value) => { setDropoff(value); setDropoffCoord(null) }} onSelect={(name, coord) => { setDropoff(name); setDropoffCoord(coord) }} placeholder="Where are you going?" maxLength={LIMITS.dropoffChars} testIdPrefix="dropoff" /></div>
      </section>

      {mode !== 'recurring' && <section><p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Choose a ride</p><div className="space-y-2">{VEHICLES.map((item) => <button type="button" key={item.id} onClick={() => setVehicle(item.id)} className={`flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition ${vehicle === item.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-[var(--paper)]'}`}><span className="grid h-10 w-12 place-items-center rounded-xl bg-[var(--ink)] text-xl text-white">{item.id === 'xl' ? '▰' : item.id === 'comfort' ? '◒' : '◐'}</span><span className="flex-1"><span className="block text-sm font-extrabold text-[var(--ink)]">{item.label}</span><span className="mt-0.5 block text-xs text-[var(--muted)]">{item.description}</span></span><span className="text-sm font-bold text-[var(--ink)]">${(1180 * item.multiplier / 100).toFixed(2)}</span></button>)}</div></section>}
      {mode === 'scheduled' && <section className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4"><p className="mb-3 text-sm font-extrabold text-[var(--ink)]">When should we pick you up?</p><div className="grid grid-cols-2 gap-3"><input aria-label="Pickup date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink)]" /><input aria-label="Pickup time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink)]" /></div></section>}
      {mode === 'recurring' && <section className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4"><p className="text-sm font-extrabold text-[var(--ink)]">Build a routine</p><p className="mt-1 text-xs text-[var(--muted)]">We’ll remind you to book when it’s time to leave.</p><div className="mt-4 flex flex-wrap gap-2">{DAYS.map((day) => <button type="button" key={day.id} aria-pressed={days.includes(day.id)} onClick={() => toggleDay(day.id)} className={`rounded-xl border px-3 py-2 text-xs font-bold ${days.includes(day.id) ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)] text-[var(--ink)]'}`}>{day.label}</button>)}</div><input aria-label="Routine time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink)]" /></section>}
      {error && <p className="rounded-xl bg-[#fff0ee] px-4 py-3 text-xs font-semibold text-[var(--error)]">{error}</p>}
      <button type="submit" disabled={!valid || saving} className="w-full rounded-2xl bg-[var(--accent)] px-5 py-4 text-sm font-extrabold text-white shadow-sm disabled:opacity-40">{saving ? 'Creating your ride…' : action}</button>
      <p className="text-center text-[11px] leading-4 text-[var(--muted)]">Estimate shown before booking. Final fare may vary with route, demand, tolls, and wait time.</p>
    </form>
  </div>
}

function AddressInput({ label, value, onChange, onSelect, placeholder, maxLength, testIdPrefix }: { label: string; value: string; onChange: (value: string) => void; onSelect: (name: string, coord: LatLng) => void; placeholder: string; maxLength: number; testIdPrefix: string }) {
  const [suggestions, setSuggestions] = useState<GeoSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => { const query = value.trim(); if (query.length < 3) { setSuggestions([]); return }; const controller = new AbortController(); const timer = setTimeout(async () => { setLoading(true); try { const results = await geocode(query, 5, { signal: controller.signal }); if (!controller.signal.aborted) setSuggestions(results.map((result) => ({ lat: result.lat, lng: result.lng, displayName: result.displayName, shortName: shortNameFor(result.displayName) }))) } catch { if (!controller.signal.aborted) setSuggestions([]) } finally { if (!controller.signal.aborted) setLoading(false) } }, 300); return () => { clearTimeout(timer); controller.abort() } }, [value])
  return <div className="relative"><label className="mb-2 block text-xs font-bold text-[var(--muted)]">{label}</label><input type="text" value={value} onChange={(e) => { onChange(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder={placeholder} maxLength={maxLength} autoComplete="off" data-testid={`${testIdPrefix}-input`} className="w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]" />{open && (loading || suggestions.length > 0) && <ul data-testid={`${testIdPrefix}-suggestions`} className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-lg">{loading && suggestions.length === 0 && <li className="px-4 py-3 text-xs text-[var(--muted)]">Searching…</li>}{suggestions.map((suggestion, index) => <li key={index}><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onSelect(suggestion.shortName, { lat: suggestion.lat, lng: suggestion.lng }); setOpen(false); setSuggestions([]) }} className="block w-full px-4 py-3 text-left hover:bg-[var(--accent-soft)]"><span className="block text-xs font-bold text-[var(--ink)]">{suggestion.shortName}</span><span className="mt-0.5 block truncate text-[10px] text-[var(--muted)]">{suggestion.displayName}</span></button></li>)}</ul>}</div>
}
