import { useState } from 'react'
import type { DayOfWeek, LatLng, RecurringRide, View } from '../types'
import { DAYS } from '../types'
import { saveRide } from '../storage'
import { app } from '../lib/app'

interface NewRideProps {
  onNavigate: (view: View) => void
}

export default function NewRide({ onNavigate }: NewRideProps) {
  const [pickup, setPickup] = useState('')
  const [dropoff, setDropoff] = useState('')
  const [days, setDays] = useState<DayOfWeek[]>(['mon', 'tue', 'wed', 'thu', 'fri'])
  const [time, setTime] = useState('08:00')
  const [driverName, setDriverName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleDay = (id: DayOfWeek) => {
    setDays((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))
  }

  const valid = pickup.trim() && dropoff.trim() && driverName.trim() && days.length > 0

  const firstResult = async (q: string): Promise<LatLng | null> => {
    const results = await app.maps.geocode(q, 1)
    return results[0] ? { lat: results[0].lat, lng: results[0].lng } : null
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const [pickupCoord, dropoffCoord] = await Promise.all([
        firstResult(pickup.trim()),
        firstResult(dropoff.trim()),
      ])
      const ride: RecurringRide = {
        id: crypto.randomUUID(),
        pickup: pickup.trim(),
        pickupCoord,
        dropoff: dropoff.trim(),
        dropoffCoord,
        days,
        time,
        driverName: driverName.trim(),
        paused: false,
        createdAt: Date.now(),
      }
      saveRide(ride)
      onNavigate({ name: 'home' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save ride')
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8 flex items-baseline gap-4">
        <button
          onClick={() => onNavigate({ name: 'home' })}
          className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        >
          ← Back
        </button>
        <h1 className="display-font text-2xl font-bold text-[var(--ink)]">New recurring ride</h1>
      </header>

      <form onSubmit={submit} className="space-y-6">
        <Field label="Pickup">
          <input
            type="text"
            value={pickup}
            onChange={(e) => setPickup(e.target.value)}
            placeholder="123 Home Street"
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </Field>

        <Field label="Dropoff">
          <input
            type="text"
            value={dropoff}
            onChange={(e) => setDropoff(e.target.value)}
            placeholder="456 School Road"
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </Field>

        <Field label="Days">
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => {
              const on = days.includes(d.id)
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDay(d.id)}
                  className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    on
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                      : 'border-[var(--line)] text-[var(--ink)] hover:bg-[var(--accent-soft)]'
                  }`}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Time">
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm tabular-nums text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
        </Field>

        <Field label="Driver">
          <input
            type="text"
            value={driverName}
            onChange={(e) => setDriverName(e.target.value)}
            placeholder="e.g. Alex Smith"
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
          <p className="mt-1.5 text-xs text-[var(--muted)]">
            For now you pick the driver by name. Matching comes later.
          </p>
        </Field>

        {error && (
          <p className="rounded-xl bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--error)]">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={!valid || saving}
            className="rounded-2xl bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? 'Geocoding…' : 'Save ride'}
          </button>
          <button
            type="button"
            onClick={() => onNavigate({ name: 'home' })}
            className="rounded-2xl border border-[var(--line)] px-6 py-2.5 text-sm font-semibold text-[var(--ink)]"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        {label}
      </span>
      {children}
    </label>
  )
}
