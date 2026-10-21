import { useCallback, useEffect, useState } from 'react'
import { showToast } from '../../lib/toast'
import {
  ACCESS_REASONS, CANCEL_REASONS, CREDIT_REASONS, ESCALATE_LEVELS, ESCALATE_REASONS, PROXIMITY_TEXT, REFUND_REASONS,
  cancelTrip, creditTrip, escalate, getEvidence, getOffers, getTimeline, getTrip, requestRefund, revealEvidence, revealTrip, searchTrips,
  type EvidencePii, type EvidencePoint, type Offer, type TimelineEntry, type TripDetail, type TripPii, type TripSummary,
} from '../../lib/opsConsole'
import { Empty, Labeled, Note, ReasonSelect, box, danger, field, outline, primary } from './ui'
import { usd, when } from './format'

const STATUSES = ['', 'scheduled', 'en_route', 'arrived', 'completed', 'cancelled']

/** Search trips, inspect one (timeline, assignment, location evidence) and act on it. Personal data stays hidden unless the ops_pii role reveals it. */
export default function TripsPanel({ canSeePii }: { canSeePii: boolean }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [results, setResults] = useState<TripSummary[] | null>(null)
  const [selected, setSelected] = useState<TripSummary | null>(null)

  const search = useCallback(async () => {
    try {
      setResults(await searchTrips(q, status))
    } catch {
      showToast({ message: "Couldn't search trips" })
    }
  }, [q, status])
  useEffect(() => {
    void search()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section aria-label="Trips" className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void search() }} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
        <input className={field} aria-label="Search trips" placeholder="Trip id, ride id, rider id, driver id or receipt number" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={field} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace('_', ' ') : 'Any status'}</option>)}
        </select>
        <button className={primary}>Search</button>
      </form>
      {results === null ? null : results.length === 0 ? (
        <Empty>No trips match. Searches match whole ids exactly.</Empty>
      ) : (
        <ul className="space-y-2">
          {results.map((t) => (
            <li key={t.trip_id}>
              <button onClick={() => setSelected(t)} aria-pressed={selected?.trip_id === t.trip_id} className={`${box} block w-full text-left ${selected?.trip_id === t.trip_id ? 'border-[var(--accent)]' : ''}`}>
                <span className="flex items-baseline justify-between gap-3"><span className="text-sm font-bold text-[var(--ink)]">{t.trip_id}</span><span className="text-xs font-semibold text-[var(--accent)]">{t.phase.replace('_', ' ')}</span></span>
                <span className="mt-1 block text-xs text-[var(--muted)]">{t.vehicle_class ?? 'share'} · {usd(t.final_cents)} · {when(t.updated_at)}{t.dispute_open ? ' · dispute open' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && <TripView key={selected.trip_id} summary={selected} canSeePii={canSeePii} onChanged={search} />}
    </section>
  )
}

function TripView({ summary, canSeePii, onChanged }: { summary: TripSummary; canSeePii: boolean; onChanged: () => void }) {
  const { rider_id: riderId, trip_id: tripId, request_id: requestId } = summary
  const [detail, setDetail] = useState<TripDetail | null>(null)
  const [offers, setOffers] = useState<Offer[]>([])
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [evidence, setEvidence] = useState<EvidencePoint[]>([])
  const [action, setAction] = useState<'cancel' | 'credit' | 'refund' | 'escalate' | null>(null)

  const load = useCallback(async () => {
    const [d, o, t, e] = await Promise.all([getTrip(riderId, tripId), getOffers(riderId, requestId), getTimeline(riderId, tripId), getEvidence(riderId, tripId)])
    setDetail(d); setOffers(o); setTimeline(t); setEvidence(e)
  }, [riderId, tripId, requestId])
  useEffect(() => {
    load().catch(() => showToast({ message: "Couldn't load that trip" }))
  }, [load])

  const done = async (message: string) => {
    setAction(null)
    showToast({ message })
    await load().catch(() => undefined)
    onChanged()
  }

  if (!detail) return <p className="text-xs text-[var(--muted)]">Loading trip…</p>
  const open = detail.phase !== 'completed' && detail.phase !== 'cancelled'
  const finished = !open

  return (
    <article aria-label={`Trip ${tripId}`} className={`${box} space-y-4`}>
      <header>
        <h2 className="text-base font-extrabold text-[var(--ink)]">{tripId}</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <Row k="Phase" v={detail.phase.replace('_', ' ')} />
          <Row k="Outcome" v={detail.outcome?.replace('_', ' ') ?? '—'} />
          <Row k="Rider" v={detail.rider_id} />
          <Row k="Driver" v={detail.driver_user_id ?? 'unassigned'} />
          <Row k="Assignment" v={detail.assignment_status ?? '—'} />
          <Row k="Dispatch" v={`${detail.dispatch_status ?? '—'}${detail.dispatch_attempts ? ` (${detail.dispatch_attempts} offers)` : ''}`} />
          <Row k="Amount" v={usd(detail.final_cents)} />
          <Row k="Credits" v={usd(detail.credits_cents)} />
          <Row k="Ended by" v={detail.cancelled_by_role ? `${detail.cancelled_by_role}${detail.cancel_code ? ` (${detail.cancel_code.replace('_', ' ')})` : ''}` : '—'} />
          <Row k="Cancellation fee" v={detail.cancel_fee_cents ? `${usd(detail.cancel_fee_cents)} ${detail.fee_policy ?? ''}` : '—'} />
          <Row k="Disputes" v={`${detail.disputes}${detail.disputes_open ? ` (${detail.disputes_open} open)` : ''}`} />
          <Row k="Refund requests" v={String(detail.refund_requests)} />
        </dl>
      </header>

      <Section title="Dispatch history">
        {offers.length === 0 ? <p className="text-xs text-[var(--muted)]">No offers.</p> : (
          <ol className="space-y-1 text-xs">{offers.map((o) => <li key={o.attempt}>#{o.attempt} {o.driver_user_id}: {o.status}{o.distance_km2 != null ? `, ${Math.sqrt(o.distance_km2).toFixed(1)} km away` : ''}</li>)}</ol>
        )}
      </Section>

      <Section title="Timeline">
        <ol className="space-y-1 text-xs">
          {timeline.map((t, i) => <li key={i}><span className="text-[var(--muted)]">{when(t.at)}</span> {t.kind === 'event' ? '◆' : '●'} <b>{t.name.replace('_', ' ')}</b> <span className="text-[var(--muted)]">{t.actor}{t.detail.trim() ? ` · ${t.detail}` : ''}</span></li>)}
        </ol>
      </Section>

      <Section title="Location evidence">
        {evidence.length === 0 ? <p className="text-xs text-[var(--muted)]">No snapshots kept for this trip.</p> : (
          <ul className="space-y-1 text-xs">{evidence.map((e) => <li key={e.kind}><b>{e.kind}</b> {when(e.captured_at)}: driver {PROXIMITY_TEXT[e.proximity] ?? e.proximity} {e.kind === 'ended' && detail.phase === 'completed' ? 'of the drop-off' : 'of the pickup'}</li>)}</ul>
        )}
      </Section>

      {canSeePii && <Reveal riderId={riderId} tripId={tripId} hasEvidence={evidence.length > 0} />}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Support actions">
        {open && <button className={outline} onClick={() => setAction('cancel')}>Cancel trip</button>}
        {finished && <button className={outline} onClick={() => setAction('credit')}>Credit</button>}
        {finished && <button className={outline} onClick={() => setAction('refund')}>Request refund</button>}
        <button className={outline} onClick={() => setAction('escalate')}>Escalate</button>
      </div>
      {action === 'cancel' && <CancelForm riderId={riderId} tripId={tripId} onDone={() => done('Trip cancelled')} onClose={() => setAction(null)} />}
      {action === 'credit' && <MoneyForm title="Credit" confirm="Apply credit" reasons={CREDIT_REASONS} run={(c, r, n) => creditTrip(riderId, tripId, c, r, n)} onDone={() => done('Credit applied')} onClose={() => setAction(null)} />}
      {action === 'refund' && <MoneyForm title="Request refund" confirm="Request refund" reasons={REFUND_REASONS} hint="Records a request for a second person to decide. No money moves while payments are not enabled." run={(c, r, n) => requestRefund(riderId, tripId, c, r, n)} onDone={() => done('Refund requested')} onClose={() => setAction(null)} />}
      {action === 'escalate' && <EscalateForm riderId={riderId} tripId={tripId} onDone={() => done('Escalated')} onClose={() => setAction(null)} />}
    </article>
  )
}

const Row = ({ k, v }: { k: string; v: string }) => <><dt className="text-[var(--muted)]">{k}</dt><dd className="text-[var(--ink)]">{v}</dd></>
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <section><h3 className="mb-1 text-xs font-extrabold uppercase tracking-wide text-[var(--muted)]">{title}</h3>{children}</section>

/** Personal details are fetched only after the person picks a reason; the reason is logged server-side first. */
function Reveal({ riderId, tripId, hasEvidence }: { riderId: string; tripId: string; hasEvidence: boolean }) {
  const [reason, setReason] = useState('')
  const [pii, setPii] = useState<TripPii | null>(null)
  const [coords, setCoords] = useState<EvidencePii[] | null>(null)
  const run = async (what: 'trip' | 'evidence') => {
    try {
      if (what === 'trip') setPii(await revealTrip(riderId, tripId, reason))
      else setCoords(await revealEvidence(riderId, tripId, reason))
    } catch {
      showToast({ message: "Couldn't open personal details" })
    }
  }
  return (
    <Section title="Personal details (ops_pii)">
      <div className="space-y-2">
        <ReasonSelect label="Why do you need these?" reasons={ACCESS_REASONS} value={reason} onChange={setReason} />
        <div className="flex gap-2">
          <button className={outline} disabled={!reason} onClick={() => run('trip')}>Show names and addresses</button>
          {hasEvidence && <button className={outline} disabled={!reason} onClick={() => run('evidence')}>Show exact locations</button>}
        </div>
        <p className="text-xs text-[var(--muted)]">Each view is logged with your name, the time and your reason.</p>
        {pii && <dl className="grid grid-cols-2 gap-x-4 text-xs"><Row k="Pickup" v={pii.pickup_label} /><Row k="Drop-off" v={pii.dropoff_label} /><Row k="Rider" v={pii.rider_name ?? '—'} /><Row k="Driver" v={pii.driver_name ?? '—'} /><Row k="Plate" v={pii.plate ?? '—'} /></dl>}
        {coords && <ul className="text-xs">{coords.map((c) => <li key={c.kind}>{c.kind}: {c.lat.toFixed(5)}, {c.lng.toFixed(5)} (±{c.accuracy_m ?? '?'} m)</li>)}</ul>}
      </div>
    </Section>
  )
}

function useSubmit(run: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await run()
      onDone()
    } catch {
      showToast({ message: 'That action was refused' })
      setBusy(false)
    }
  }
  return { busy, submit }
}

function CancelForm({ riderId, tripId, onDone, onClose }: { riderId: string; tripId: string; onDone: () => void; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [fee, setFee] = useState('0')
  const { busy, submit } = useSubmit(() => cancelTrip(riderId, tripId, reason, note, Number(fee) * 100), onDone)
  return (
    <form role="group" aria-label="Cancel trip" onSubmit={submit} className="space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <ReasonSelect reasons={CANCEL_REASONS} value={reason} onChange={setReason} />
      <Note value={note} onChange={setNote} />
      <Labeled label="Cancellation fee to charge (USD, capped at the fare)"><input className={field} type="number" min="0" step="any" value={fee} onChange={(e) => setFee(e.target.value)} /></Labeled>
      <div className="flex gap-2"><button className={danger} disabled={busy || !reason || !note.trim()}>Cancel trip</button><button type="button" className={outline} onClick={onClose}>Close</button></div>
    </form>
  )
}

function MoneyForm({ title, confirm, reasons, hint, run, onDone, onClose }: { title: string; confirm: string; reasons: typeof CREDIT_REASONS; hint?: string; run: (cents: number, reason: string, note: string) => Promise<unknown>; onDone: () => void; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')
  const cents = Math.round(Number(amount) * 100)
  const { busy, submit } = useSubmit(() => run(cents, reason, note), onDone)
  return (
    <form role="group" aria-label={title} onSubmit={submit} className="space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <Labeled label="Amount (USD)"><input className={field} type="number" min="0.01" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /></Labeled>
      <ReasonSelect reasons={reasons} value={reason} onChange={setReason} />
      <Note value={note} onChange={setNote} />
      {hint && <p className="text-xs text-[var(--muted)]">{hint}</p>}
      <div className="flex gap-2"><button className={primary} disabled={busy || !reason || !note.trim() || !(cents > 0)}>{confirm}</button><button type="button" className={outline} onClick={onClose}>Close</button></div>
    </form>
  )
}

function EscalateForm({ riderId, tripId, onDone, onClose }: { riderId: string; tripId: string; onDone: () => void; onClose: () => void }) {
  const [level, setLevel] = useState<string>(ESCALATE_LEVELS[0].code)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const { busy, submit } = useSubmit(() => escalate({ riderId, tripId }, level, reason, note), onDone)
  return (
    <form role="group" aria-label="Escalate" onSubmit={submit} className="space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <Labeled label="Escalate to"><select className={field} value={level} onChange={(e) => setLevel(e.target.value)}>{ESCALATE_LEVELS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select></Labeled>
      <ReasonSelect reasons={ESCALATE_REASONS} value={reason} onChange={setReason} />
      <Note value={note} onChange={setNote} />
      <div className="flex gap-2"><button className={primary} disabled={busy || !reason || !note.trim()}>Escalate</button><button type="button" className={outline} onClick={onClose}>Close</button></div>
    </form>
  )
}

