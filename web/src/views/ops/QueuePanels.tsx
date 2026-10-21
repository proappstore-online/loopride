import { useCallback, useEffect, useState } from 'react'
import { showToast } from '../../lib/toast'
import { decideRefund, listAudit, listDisputes, listEscalations, listRefunds, resolveDispute, resolveEscalation, type AuditEntry, type Dispute, type Escalation } from '../../lib/opsConsole'
import { Empty, Note, box, field, outline, primary } from './ui'
import { usd, when } from './format'

function useQueue<T>(load: () => Promise<T[]>, failure: string) {
  const [rows, setRows] = useState<T[] | null>(null)
  const refresh = useCallback(async () => {
    try {
      setRows(await load())
    } catch {
      showToast({ message: failure })
    }
  }, [load, failure])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { rows, refresh }
}

/** Run an action; refusals (second-person rules, role checks) are shown rather than hidden. */
async function attempt(run: () => Promise<unknown>, ok: string, then: () => void) {
  try {
    await run()
    showToast({ message: ok })
    then()
  } catch {
    showToast({ message: 'That action was refused' })
  }
}

export function DisputesPanel() {
  const { rows, refresh } = useQueue(listDisputes, "Couldn't load disputes")
  const [note, setNote] = useState<Record<string, string>>({})
  const [waive, setWaive] = useState<Record<string, boolean>>({})
  const key = (d: Dispute) => `${d.trip_id}:${d.opened_by}`
  return (
    <section aria-label="Disputes" className="space-y-3">
      {rows !== null && rows.length === 0 && <Empty>No open disputes.</Empty>}
      <ul className="space-y-3">
        {(rows ?? []).map((d) => (
          <li key={key(d)} className={box}>
            <p className="text-sm font-bold text-[var(--ink)]">{d.trip_id} <span className="font-normal text-[var(--muted)]">· opened by the {d.opened_role}</span></p>
            <p className="text-xs text-[var(--muted)]">{d.reason_code.replace('_', ' ')} · {d.outcome?.replace('_', ' ') ?? 'no outcome'} · fee {usd(d.cancel_fee_cents)} · {when(d.opened_at)}</p>
            {d.note && <p className="mt-1 text-xs text-[var(--ink)]">“{d.note}”</p>}
            <div className="mt-3 space-y-2">
              <Note label="Decision note" value={note[key(d)] ?? ''} onChange={(v) => setNote({ ...note, [key(d)]: v })} />
              {(d.cancel_fee_cents ?? 0) > 0 && <label className="flex items-center gap-2 text-xs text-[var(--ink)]"><input type="checkbox" checked={waive[key(d)] ?? false} onChange={(e) => setWaive({ ...waive, [key(d)]: e.target.checked })} /> Waive the {usd(d.cancel_fee_cents)} fee if upheld</label>}
              <div className="flex gap-2">
                {(['upheld', 'rejected'] as const).map((decision) => (
                  <button key={decision} className={decision === 'upheld' ? primary : outline} disabled={!(note[key(d)] ?? '').trim()} onClick={() => attempt(() => resolveDispute(d, decision, note[key(d)] ?? '', waive[key(d)] ?? false), `Dispute ${decision}`, refresh)}>{decision === 'upheld' ? 'Uphold' : 'Reject'}</button>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function RefundsPanel() {
  const { rows, refresh } = useQueue(listRefunds, "Couldn't load refund requests")
  const [note, setNote] = useState<Record<string, string>>({})
  return (
    <section aria-label="Refunds" className="space-y-3">
      <p className="text-xs text-[var(--muted)]">Approving records the decision only. No money moves while payments are not enabled. Someone other than the requester must decide.</p>
      {rows !== null && rows.length === 0 && <Empty>No refund requests waiting.</Empty>}
      <ul className="space-y-3">
        {(rows ?? []).map((r) => (
          <li key={r.request_key} className={box}>
            <p className="text-sm font-bold text-[var(--ink)]">{usd(r.amount_cents)} · {r.trip_id}</p>
            <p className="text-xs text-[var(--muted)]">{r.reason_code.replace('_', ' ')} · requested by {r.requested_by} · {when(r.requested_at)}</p>
            <p className="mt-1 text-xs text-[var(--ink)]">“{r.note}”</p>
            <div className="mt-3 space-y-2">
              <Note label="Decision note" value={note[r.request_key] ?? ''} onChange={(v) => setNote({ ...note, [r.request_key]: v })} />
              <div className="flex gap-2">
                <button className={primary} disabled={!(note[r.request_key] ?? '').trim()} onClick={() => attempt(() => decideRefund(r, 'approved', note[r.request_key] ?? ''), 'Refund approved', refresh)}>Approve</button>
                <button className={outline} disabled={!(note[r.request_key] ?? '').trim()} onClick={() => attempt(() => decideRefund(r, 'rejected', note[r.request_key] ?? ''), 'Refund rejected', refresh)}>Reject</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function EscalationsPanel() {
  const { rows, refresh } = useQueue(listEscalations, "Couldn't load escalations")
  const [note, setNote] = useState<Record<string, string>>({})
  return (
    <section aria-label="Escalations" className="space-y-3">
      {rows !== null && rows.length === 0 && <Empty>No open escalations.</Empty>}
      <ul className="space-y-3">
        {(rows ?? []).map((e: Escalation) => (
          <li key={e.id} className={box}>
            <p className="text-sm font-bold text-[var(--ink)]">{e.level} · {e.reason_code.replace('_', ' ')}</p>
            <p className="text-xs text-[var(--muted)]">{e.trip_id ?? `driver ${e.driver_user_id}`} · opened by {e.opened_by} · {when(e.opened_at)}</p>
            <p className="mt-1 text-xs text-[var(--ink)]">“{e.note}”</p>
            <div className="mt-3 space-y-2">
              <Note label="Resolution note" value={note[e.id] ?? ''} onChange={(v) => setNote({ ...note, [e.id]: v })} />
              <button className={primary} disabled={!(note[e.id] ?? '').trim()} onClick={() => attempt(() => resolveEscalation(e.id, note[e.id] ?? ''), 'Escalation resolved', refresh)}>Resolve</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AuditPanel() {
  const [trip, setTrip] = useState('')
  const [actor, setActor] = useState('')
  const [rows, setRows] = useState<AuditEntry[] | null>(null)
  const run = useCallback(async () => {
    try {
      setRows(await listAudit(trip, actor))
    } catch {
      showToast({ message: "Couldn't load the audit trail" })
    }
  }, [trip, actor])
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <section aria-label="Audit" className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); void run() }} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input className={field} aria-label="Filter by trip id" placeholder="Trip id" value={trip} onChange={(e) => setTrip(e.target.value)} />
        <input className={field} aria-label="Filter by staff member" placeholder="Staff member id" value={actor} onChange={(e) => setActor(e.target.value)} />
        <button className={primary}>Filter</button>
      </form>
      {rows !== null && rows.length === 0 && <Empty>Nothing recorded.</Empty>}
      <ol className="space-y-1">
        {(rows ?? []).map((a, i) => (
          <li key={i} className="rounded-xl border border-[var(--line)] px-3 py-2 text-xs text-[var(--ink)]">
            <b>{a.action.replaceAll('_', ' ')}</b> by {a.actor_id} · {when(a.at)}
            <span className="block text-[var(--muted)]">{[a.trip_id ?? (a.driver_user_id ? `driver ${a.driver_user_id}` : null), a.reason_code, a.amount_cents != null ? usd(a.amount_cents) : null].filter(Boolean).join(' · ')}</span>
            {a.note && <span className="block">“{a.note}”</span>}
          </li>
        ))}
      </ol>
    </section>
  )
}
