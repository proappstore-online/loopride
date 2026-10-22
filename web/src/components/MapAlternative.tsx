/** The map as text: the same pickup, drop-off, driver and ETA a sighted rider reads off the map. */
export interface MapAlternativeRow { label: string; value: string }

export default function MapAlternative({ rows }: { rows: MapAlternativeRow[] }) {
  return (
    <section aria-label="Route details" className="mt-3 rounded-2xl border border-[var(--line)] p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Route details <span className="font-normal normal-case">(text version of the map)</span></h2>
      <dl className="mt-2 space-y-1 text-sm text-[var(--ink)]">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap gap-x-2">
            <dt className="font-semibold">{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
