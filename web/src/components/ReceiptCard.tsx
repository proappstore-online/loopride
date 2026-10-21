import { BASIS_LABEL, money, type Receipt } from '../lib/receipts'

/** An immutable trip statement. It records what is owed; it is not proof of payment. */
export default function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const r = receipt
  const m = (c: number) => money(c, r.currency)
  const hasComponents = r.baseCents !== null
  const surge = r.surgeMilli && r.surgeMilli > 1000 ? `${Number((r.surgeMilli / 1000).toFixed(2))}×` : null
  return (
    <section aria-label="Receipt" className="rounded-3xl border border-[var(--line)] p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Receipt</p>
        <p className="text-xs font-semibold text-[var(--muted)]">{r.receiptNo} · {new Date(r.finalizedAt).toLocaleDateString()}</p>
      </div>
      {(r.pickup || r.dropoff) && <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{r.pickup} → {r.dropoff}</p>}
      <dl className="mt-3 space-y-1 text-sm text-[var(--ink)]">
        {r.basis === 'fare' && hasComponents && (
          <>
            <Line label="Base fare" value={m(r.baseCents ?? 0)} />
            <Line label="Distance" value={m(r.distanceCents ?? 0)} />
            <Line label="Time" value={m(r.timeCents ?? 0)} />
            <Line label="Booking fee" value={m(r.bookingFeeCents ?? 0)} />
            {(r.minAdjustCents ?? 0) > 0 && <Line label="Minimum fare adjustment" value={m(r.minAdjustCents ?? 0)} />}
            {surge && <Line label="High demand" value={surge} />}
          </>
        )}
        <Line label={BASIS_LABEL[r.basis]} value={m(r.finalCents)} strong />
        {r.taxCents > 0 && <Line label={`Includes tax (${(r.taxRateBp / 100).toFixed(2)}%)`} value={m(r.taxCents)} />}
        {r.creditsCents > 0 && <Line label="Credits" value={`−${m(r.creditsCents)}`} />}
        <Line label="Total" value={m(r.totalCents)} strong />
      </dl>
      <p className="mt-3 text-xs leading-5 text-[var(--muted)]">
        Payment is not collected in the app yet. This receipt records what the trip cost under the price you accepted. It never changes after the trip; any correction appears as a credit.
      </p>
    </section>
  )
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`flex justify-between gap-3 ${strong ? 'font-extrabold' : 'text-[var(--muted)]'}`}><dt>{label}</dt><dd>{value}</dd></div>
}
