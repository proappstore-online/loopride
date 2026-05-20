import { useEffect, useState } from 'react'
import type { DayOfWeek, LatLng, RecurringRide, View } from '../types'
import { DAYS } from '../types'
import { saveRide } from '../storage'
import { app } from '../lib/app'
import { LIMITS } from '../lib/constants'

interface NewRideProps {
  onNavigate: (view: View) => void
}

interface GeoSuggestion {
  lat: number
  lng: number
  /** Full Nominatim display name — what we show in the dropdown. */
  displayName: string
  /** Short label suitable for the input field after selection. */
  shortName: string
}

/**
 * Nominatim displayName tends to be a 10-segment comma-separated address.
 * For an input field we want something usable: the POI name if there is one
 * (first segment), or "<house-number> <street>" when the first segment is
 * a bare number.
 */
function shortNameFor(displayName: string): string {
  const parts = displayName.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return displayName
  if (parts.length > 1 && /^\d+[a-z]?$/i.test(parts[0])) {
    return `${parts[0]} ${parts[1]}`
  }
  return parts[0]
}

export default function NewRide({ onNavigate }: NewRideProps) {
  const [pickup, setPickup] = useState('')
  const [pickupCoord, setPickupCoord] = useState<LatLng | null>(null)
  const [dropoff, setDropoff] = useState('')
  const [dropoffCoord, setDropoffCoord] = useState<LatLng | null>(null)
  const [days, setDays] = useState<DayOfWeek[]>(['mon', 'tue', 'wed', 'thu', 'fri'])
  const [time, setTime] = useState('08:00')
  const [driverName, setDriverName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleDay = (id: DayOfWeek) => {
    setDays((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))
  }

  const valid = pickup.trim() && dropoff.trim() && driverName.trim() && days.length > 0

  const ensureCoord = async (q: string, picked: LatLng | null): Promise<LatLng | null> => {
    if (picked) return picked
    const results = await app.maps.geocode(q, 1)
    return results[0] ? { lat: results[0].lat, lng: results[0].lng } : null
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const trimmedPickup = pickup.trim().slice(0, LIMITS.pickupChars)
      const trimmedDropoff = dropoff.trim().slice(0, LIMITS.dropoffChars)
      const trimmedDriver = driverName.trim().slice(0, LIMITS.driverNameChars)
      const [resolvedPickup, resolvedDropoff] = await Promise.all([
        ensureCoord(trimmedPickup, pickupCoord),
        ensureCoord(trimmedDropoff, dropoffCoord),
      ])
      const ride: RecurringRide = {
        id: crypto.randomUUID(),
        pickup: trimmedPickup,
        pickupCoord: resolvedPickup,
        dropoff: trimmedDropoff,
        dropoffCoord: resolvedDropoff,
        days,
        time,
        driverName: trimmedDriver,
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
          <AddressInput
            value={pickup}
            onChange={(v) => {
              setPickup(v)
              setPickupCoord(null)
            }}
            onSelect={(displayName, coord) => {
              setPickup(displayName)
              setPickupCoord(coord)
            }}
            placeholder="123 Home Street"
            maxLength={LIMITS.pickupChars}
            testIdPrefix="pickup"
          />
        </Field>

        <Field label="Dropoff">
          <AddressInput
            value={dropoff}
            onChange={(v) => {
              setDropoff(v)
              setDropoffCoord(null)
            }}
            onSelect={(displayName, coord) => {
              setDropoff(displayName)
              setDropoffCoord(coord)
            }}
            placeholder="456 School Road"
            maxLength={LIMITS.dropoffChars}
            testIdPrefix="dropoff"
          />
        </Field>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Days
          </legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => {
              const on = days.includes(d.id)
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={on}
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
        </fieldset>

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
            maxLength={LIMITS.driverNameChars}
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
            {saving ? 'Saving…' : 'Save ride'}
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

function AddressInput({
  value,
  onChange,
  onSelect,
  placeholder,
  maxLength,
  testIdPrefix,
}: {
  value: string
  onChange: (v: string) => void
  onSelect: (displayName: string, coord: LatLng) => void
  placeholder: string
  maxLength: number
  testIdPrefix: string
}) {
  const [suggestions, setSuggestions] = useState<GeoSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const q = value.trim()
    if (q.length < 3) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setLoading(true)
      try {
        const results = await app.maps.geocode(q, 5)
        if (!cancelled) {
          setSuggestions(
            results.map((r) => ({
              lat: r.lat,
              lng: r.lng,
              displayName: r.displayName,
              shortName: shortNameFor(r.displayName),
            })),
          )
        }
      } catch {
        if (!cancelled) setSuggestions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [value])

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        aria-autocomplete="list"
        data-testid={`${testIdPrefix}-input`}
        className="w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
      />
      {open && (loading || suggestions.length > 0) && (
        <ul
          data-testid={`${testIdPrefix}-suggestions`}
          className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-lg"
        >
          {loading && suggestions.length === 0 && (
            <li className="px-4 py-2 text-xs text-[var(--muted)]">Searching…</li>
          )}
          {suggestions.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(s.shortName, { lat: s.lat, lng: s.lng })
                  setOpen(false)
                  setSuggestions([])
                }}
                className="block w-full px-4 py-2 text-left text-xs text-[var(--ink)] hover:bg-[var(--accent-soft)]"
                title={s.displayName}
              >
                <span className="block font-medium">{s.shortName}</span>
                <span className="block truncate text-[10px] text-[var(--muted)]">
                  {s.displayName}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
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
