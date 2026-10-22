import { useEffect, useId, useState } from 'react'
import type { LatLng } from '../types'
import { geocode } from '../lib/maps'
import { shortNameFor } from '../lib/address'

interface Suggestion { lat: number; lng: number; displayName: string; shortName: string }

interface Props {
  label: string
  value: string
  onChange: (value: string) => void
  onSelect: (name: string, coord: LatLng) => void
  placeholder: string
  maxLength: number
  testIdPrefix: string
}

/**
 * Address field with suggestions, built as an ARIA combobox so a keyboard or screen-reader user can
 * type, move through the suggestions with the arrow keys, pick with Enter and dismiss with Escape.
 * The number of suggestions is announced through a polite live region.
 */
export default function AddressInput({ label, value, onChange, onSelect, placeholder, maxLength, testIdPrefix }: Props) {
  const id = useId()
  const listId = `${id}-list`
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(-1)

  useEffect(() => {
    const query = value.trim()
    if (query.length < 3) {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const results = await geocode(query, 5, { signal: controller.signal })
        if (!controller.signal.aborted) {
          setSuggestions(results.map((r) => ({ lat: r.lat, lng: r.lng, displayName: r.displayName, shortName: shortNameFor(r.displayName) })))
          setActive(-1)
        }
      } catch {
        if (!controller.signal.aborted) setSuggestions([])
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [value])

  const expanded = open && suggestions.length > 0
  const choose = (s: Suggestion) => {
    onSelect(s.shortName, { lat: s.lat, lng: s.lng })
    setOpen(false)
    setSuggestions([])
    setActive(-1)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      e.preventDefault()
      setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + suggestions.length + (i === -1 && step === -1 ? 1 : 0)) % suggestions.length)
    } else if (e.key === 'Enter' && expanded && active >= 0) {
      e.preventDefault()
      choose(suggestions[active])
    } else if (e.key === 'Escape' && expanded) {
      e.preventDefault()
      setOpen(false)
    }
  }
  const status = loading ? 'Searching for addresses' : expanded ? `${suggestions.length} ${suggestions.length === 1 ? 'suggestion' : 'suggestions'} available. Use the up and down arrow keys to review them.` : ''

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-2 block text-xs font-bold text-[var(--muted)]">{label}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? `${id}-opt-${active}` : undefined}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        data-testid={`${testIdPrefix}-input`}
        className="w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-sm text-[var(--ink)]"
      />
      <p role="status" className="sr-only">{status}</p>
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label} suggestions`}
        hidden={!expanded}
        data-testid={`${testIdPrefix}-suggestions`}
        className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-lg"
      >
        {suggestions.map((s, index) => (
          <li
            key={index}
            id={`${id}-opt-${index}`}
            role="option"
            aria-selected={index === active}
            // mousedown would blur the field and close the list before the click lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(s)}
            className={`min-h-11 cursor-pointer px-4 py-3 text-left ${index === active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--accent-soft)]'}`}
          >
            <span className="block text-xs font-bold text-[var(--ink)]">{s.shortName}</span>
            <span className="mt-0.5 block truncate text-[11px] text-[var(--muted)]">{s.displayName}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
