import { useCallback, useEffect, useState } from 'react'
import { showToast } from '../../lib/toast'
import { decisionsFor, listApplications, reviewApplication, type ApplicationStatus, type ApplicationSummary, type Decision } from '../../lib/driverOnboarding'
import { ACCESS_REASONS, ESCALATE_LEVELS, ESCALATE_REASONS, REINSTATE_REASONS, SUSPEND_REASONS, escalate, reinstateDriver, revealDriver, suspendDriver, type DriverPii } from '../../lib/opsConsole'
import { Empty, Labeled, Note, ReasonSelect, box, danger, field, outline, primary } from './ui'

const FILTERS: ApplicationStatus[] = ['submitted', 'approved', 'rejected', 'suspended']
const VERB: Record<Decision, string> = { approved: 'Approve', rejected: 'Reject' }

/** Driver applications and standing. Names and licence details are redacted unless the ops_pii role reveals them with a logged reason. */
export default function DriversPanel({ canSeePii }: { canSeePii: boolean }) {
  const [filter, setFilter] = useState<ApplicationStatus>('submitted')
  const [rows, setRows] = useState<ApplicationSummary[] | null>(null)
  const [open, setOpen] = useState<{ id: string; form: 'suspend' | 'reinstate' | 'escalate' | 'reveal' } | null>(null)
  const [reasons, setReasons] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      setRows(await listApplications(filter))
    } catch {
      showToast({ message: "Couldn't load applications" })
    }
  }, [filter])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const decide = async (row: ApplicationSummary, decision: Decision) => {
    const reason = reasons[row.user_id] ?? ''
    if (decision !== 'approved' && !reason.trim()) return showToast({ message: 'Enter a reason first' })
    try {
      await reviewApplication(row.user_id, decision, reason)
      await refresh()
    } catch {
      showToast({ message: "Couldn't record the decision" })
    }
  }

  return (
    <section aria-label="Drivers" className="space-y-3">
      <div role="tablist" className="flex gap-2">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`rounded-full border px-3 py-1 text-xs font-bold capitalize ${filter === f ? 'border-[var(--ink)] bg-[var(--ink)] text-white' : 'border-[var(--line)] text-[var(--ink)]'}`}>{f}</button>
        ))}
      </div>
      {rows !== null && rows.length === 0 && <Empty>No {filter} applications.</Empty>}
      <ul className="space-y-3">
        {(rows ?? []).map((row) => (
          <li key={row.user_id} className={box}>
            <p className="text-sm font-bold text-[var(--ink)]">{row.user_id} <span className="font-normal text-[var(--muted)]">· {row.initial ?? '?'}</span></p>
            <p className="text-xs text-[var(--muted)]">Phone {row.phone_masked ?? '—'} · Licence …{row.licence_last4} ({row.licence_region}), expires {row.licence_expires} · {row.vehicle_count} vehicle(s)</p>
            {decisionsFor(row.status).length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input aria-label={`Reason for ${row.user_id}`} placeholder="Reason (required to reject)" className="min-w-0 flex-1 rounded-xl border border-[var(--line)] px-3 py-1.5 text-xs" value={reasons[row.user_id] ?? ''} onChange={(e) => setReasons({ ...reasons, [row.user_id]: e.target.value })} />
                {decisionsFor(row.status).map((d) => <button key={d} onClick={() => decide(row, d)} className={outline}>{VERB[d]}</button>)}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Actions for ${row.user_id}`}>
              {row.status === 'approved' && <button className={outline} onClick={() => setOpen({ id: row.user_id, form: 'suspend' })}>Suspend</button>}
              {row.status === 'suspended' && <button className={outline} onClick={() => setOpen({ id: row.user_id, form: 'reinstate' })}>Reinstate</button>}
              <button className={outline} onClick={() => setOpen({ id: row.user_id, form: 'escalate' })}>Escalate</button>
              {canSeePii && <button className={outline} onClick={() => setOpen({ id: row.user_id, form: 'reveal' })}>Show personal details</button>}
            </div>
            {open?.id === row.user_id && open.form === 'suspend' && <StandingForm title="Suspend driver" confirm="Suspend" reasons={SUSPEND_REASONS} run={(r, n) => suspendDriver(row.user_id, r, n)} onDone={() => { setOpen(null); showToast({ message: 'Driver suspended' }); void refresh() }} onClose={() => setOpen(null)} destructive />}
            {open?.id === row.user_id && open.form === 'reinstate' && <StandingForm title="Reinstate driver" confirm="Reinstate" reasons={REINSTATE_REASONS} run={(r, n) => reinstateDriver(row.user_id, r, n)} onDone={() => { setOpen(null); showToast({ message: 'Driver reinstated' }); void refresh() }} onClose={() => setOpen(null)} />}
            {open?.id === row.user_id && open.form === 'escalate' && <EscalateDriver id={row.user_id} onDone={() => { setOpen(null); showToast({ message: 'Escalated' }) }} onClose={() => setOpen(null)} />}
            {open?.id === row.user_id && open.form === 'reveal' && <RevealDriver id={row.user_id} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

function StandingForm({ title, confirm, reasons, run, onDone, onClose, destructive = false }: { title: string; confirm: string; reasons: typeof SUSPEND_REASONS; run: (reason: string, note: string) => Promise<unknown>; onDone: () => void; onClose: () => void; destructive?: boolean }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await run(reason, note)
      onDone()
    } catch {
      showToast({ message: 'That action was refused' })
      setBusy(false)
    }
  }
  return (
    <form role="group" aria-label={title} onSubmit={submit} className="mt-3 space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <ReasonSelect reasons={reasons} value={reason} onChange={setReason} />
      <Note value={note} onChange={setNote} />
      <div className="flex gap-2"><button className={destructive ? danger : primary} disabled={busy || !reason || !note.trim()}>{confirm}</button><button type="button" className={outline} onClick={onClose}>Close</button></div>
    </form>
  )
}

function EscalateDriver({ id, onDone, onClose }: { id: string; onDone: () => void; onClose: () => void }) {
  const [level, setLevel] = useState<string>(ESCALATE_LEVELS[0].code)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await escalate({ driverUserId: id }, level, reason, note)
      onDone()
    } catch {
      showToast({ message: 'That action was refused' })
      setBusy(false)
    }
  }
  return (
    <form role="group" aria-label="Escalate driver" onSubmit={submit} className="mt-3 space-y-3 rounded-2xl bg-[var(--accent-soft)] p-4">
      <Labeled label="Escalate to"><select className={field} value={level} onChange={(e) => setLevel(e.target.value)}>{ESCALATE_LEVELS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select></Labeled>
      <ReasonSelect reasons={ESCALATE_REASONS} value={reason} onChange={setReason} />
      <Note value={note} onChange={setNote} />
      <div className="flex gap-2"><button className={primary} disabled={busy || !reason || !note.trim()}>Escalate</button><button type="button" className={outline} onClick={onClose}>Close</button></div>
    </form>
  )
}

function RevealDriver({ id }: { id: string }) {
  const [reason, setReason] = useState('')
  const [pii, setPii] = useState<DriverPii | null>(null)
  const show = async () => {
    try {
      setPii(await revealDriver(id, reason))
    } catch {
      showToast({ message: "Couldn't open personal details" })
    }
  }
  return (
    <div className="mt-3 space-y-2 rounded-2xl bg-[var(--accent-soft)] p-4">
      <ReasonSelect label="Why do you need these?" reasons={ACCESS_REASONS} value={reason} onChange={setReason} />
      <button className={outline} disabled={!reason} onClick={show}>Show details</button>
      <p className="text-xs text-[var(--muted)]">Logged with your name, the time and your reason.</p>
      {pii && <dl className="text-xs"><dt className="inline text-[var(--muted)]">Name </dt><dd className="inline">{pii.full_name}</dd><br /><dt className="inline text-[var(--muted)]">Phone </dt><dd className="inline">{pii.phone}</dd><br /><dt className="inline text-[var(--muted)]">Licence </dt><dd className="inline">{pii.licence_number} ({pii.licence_region}, expires {pii.licence_expires})</dd></dl>}
    </div>
  )
}
