import { useCallback, useEffect, useState } from 'react'
import { showToast } from '../../lib/toast'
import {
  ACCESS_REASONS, BLOCK_REASONS, SAFETY_RESOLUTIONS, SUSPEND_REASONS, UNBLOCK_REASONS,
  acknowledgeSafetyReport, blockRider, liftRiderBlock, listRiderBlocks, listSafetyReports, resolveSafetyReport, revealSafetyReport, suspendDriver,
  type RiderBlock, type SafetyPii, type SafetyReport,
} from '../../lib/opsConsole'
import { Empty, Note, ReasonSelect, box, danger, outline, primary } from './ui'
import { when } from './format'

type Form = 'resolve' | 'suspend' | 'block' | 'reveal'

/** Safety reports, urgent first, and the riders who are blocked. Every action here is audited server-side. */
export default function SafetyPanel({ canSeePii }: { canSeePii: boolean }) {
  const [rows, setRows] = useState<SafetyReport[] | null>(null)
  const [blocks, setBlocks] = useState<RiderBlock[] | null>(null)
  const [open, setOpen] = useState<{ id: string; form: Form } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [r, b] = await Promise.all([listSafetyReports(), listRiderBlocks()])
      setRows(r)
      setBlocks(b)
    } catch {
      showToast({ message: "Couldn't load safety reports" })
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const done = (message: string) => { setOpen(null); showToast({ message }); void refresh() }
  const ack = async (id: string) => {
    try {
      await acknowledgeSafetyReport(id)
      done('Report acknowledged')
    } catch {
      showToast({ message: 'That action was refused' })
    }
  }

  return (
    <section aria-label="Safety" className="space-y-4">
      <p className="text-xs text-[var(--muted)]">Urgent reports come first. Acknowledge one as soon as someone is on it; an urgent report nobody acknowledges within 5 minutes raises a critical alert on the Health tab. Follow <a className="underline" href="https://github.com/proappstore-online/loopride/blob/main/docs/runbooks/safety-incident.md">the safety incident runbook</a>.</p>
      {rows !== null && rows.length === 0 && <Empty>No open safety reports.</Empty>}
      <ul className="space-y-3">
        {(rows ?? []).map((r) => (
          <li key={r.id} className={box}>
            <p className="text-sm font-bold text-[var(--ink)]">
              {r.urgency === 'urgent' && <span className="mr-2 rounded-full bg-[var(--error)] px-2 py-0.5 text-[10px] uppercase text-white">Urgent</span>}
              {r.category.replaceAll('_', ' ')} <span className="font-normal text-[var(--muted)]">· reported by the {r.reporter_role}</span>
            </p>
            <p className="text-xs text-[var(--muted)]">{r.trip_id} · {r.trip_phase.replace('_', ' ')} · {r.status.replace('_', ' ')} · {when(r.created_at)}</p>
            <p className="text-xs text-[var(--muted)]">Rider {r.rider_id} · {r.subject_role ? `${r.subject_role} reported: ${r.subject_id ?? 'unknown'}` : 'no one else on the trip yet'}</p>
            {r.note && <p className="mt-1 text-xs text-[var(--ink)]">“{r.note}”</p>}
            {r.acknowledged_by && <p className="text-xs text-[var(--muted)]">Acknowledged by {r.acknowledged_by} · {when(r.acknowledged_at)}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {r.status === 'open' && <button className={primary} onClick={() => ack(r.id)}>Acknowledge</button>}
              {canSeePii && <button className={outline} onClick={() => setOpen({ id: r.id, form: 'reveal' })}>Show details</button>}
              {r.subject_role === 'driver' && r.subject_id && <button className={outline} onClick={() => setOpen({ id: r.id, form: 'suspend' })}>Suspend driver</button>}
              {r.subject_role === 'rider' && r.subject_id && <button className={outline} onClick={() => setOpen({ id: r.id, form: 'block' })}>Block rider</button>}
              <button className={outline} onClick={() => setOpen({ id: r.id, form: 'resolve' })}>Resolve</button>
            </div>
            {open?.id === r.id && open.form === 'resolve' && <ResolveForm report={r} onDone={() => done('Report resolved')} onClose={() => setOpen(null)} />}
            {open?.id === r.id && open.form === 'suspend' && r.subject_id && (
              <ActionForm title="Suspend driver" confirm="Suspend" reasons={SUSPEND_REASONS} initial="safety" destructive run={(c, n) => suspendDriver(r.subject_id!, c, n)} onDone={() => done('Driver suspended')} onClose={() => setOpen(null)} />
            )}
            {open?.id === r.id && open.form === 'block' && r.subject_id && (
              <ActionForm title="Block rider" confirm="Block" reasons={BLOCK_REASONS} initial="safety" destructive run={(c, n) => blockRider(r.subject_id!, c, n, r.id)} onDone={() => done('Rider blocked')} onClose={() => setOpen(null)} />
            )}
            {open?.id === r.id && open.form === 'reveal' && <Reveal report={r} />}
          </li>
        ))}
      </ul>

      <h2 className="pt-2 text-sm font-bold text-[var(--ink)]">Blocked riders</h2>
      {blocks !== null && blocks.length === 0 && <Empty>No riders are blocked.</Empty>}
      <ul className="space-y-2">
        {(blocks ?? []).map((b) => (
          <li key={b.rider_id} className={box}>
            <p className="text-sm font-bold text-[var(--ink)]">{b.rider_id}</p>
            <p className="text-xs text-[var(--muted)]">{b.reason_code.replace('_', ' ')} · by {b.actor_id} · {when(b.at)}</p>
            <p className="mt-1 text-xs text-[var(--ink)]">“{b.note}”</p>
            <button className={`${outline} mt-2`} onClick={() => setOpen({ id: `block:${b.rider_id}`, form: 'resolve' })}>Lift block</button>
            {open?.id === `block:${b.rider_id}` && (
              <ActionForm title="Lift block" confirm="Lift block" reasons={UNBLOCK_REASONS} run={(c, n) => liftRiderBlock(b.rider_id, c, n)} onDone={() => done('Block lifted')} onClose={() => setOpen(null)} />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function ActionForm({ title, confirm, reasons, initial = '', destructive, run, onDone, onClose }: {
  title: string; confirm: string; reasons: { code: string; label: string }[]; initial?: string; destructive?: boolean
  run: (code: string, note: string) => Promise<unknown>; onDone: () => void; onClose: () => void
}) {
  const [reason, setReason] = useState(initial)
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

function ResolveForm({ report, onDone, onClose }: { report: SafetyReport; onDone: () => void; onClose: () => void }) {
  return <ActionForm title="Resolve report" confirm="Resolve" reasons={SAFETY_RESOLUTIONS} run={(c, n) => resolveSafetyReport(report.id, c, n)} onDone={onDone} onClose={onClose} />
}

function Reveal({ report }: { report: SafetyReport }) {
  const [reason, setReason] = useState('')
  const [pos, setPos] = useState(false)
  const [pii, setPii] = useState<SafetyPii | null | undefined>(undefined)
  const show = async () => {
    try {
      setPii(await revealSafetyReport(report, reason, pos))
    } catch {
      showToast({ message: "Couldn't open personal details" })
    }
  }
  return (
    <div className="mt-3 space-y-2 rounded-2xl bg-[var(--accent-soft)] p-4">
      <ReasonSelect label="Why do you need these?" reasons={ACCESS_REASONS} value={reason} onChange={setReason} />
      <label className="flex items-center gap-2 text-xs text-[var(--ink)]"><input type="checkbox" checked={pos} onChange={(e) => setPos(e.target.checked)} /> Also show the driver's last shared position</label>
      <button className={outline} disabled={!reason} onClick={show}>Show details</button>
      <p className="text-xs text-[var(--muted)]">Logged with your name, the time and your reason. Kept with the report for 30 days.</p>
      {pii === null && <p className="text-xs text-[var(--muted)]">No details are kept for this report (it may be older than 30 days, or the rider deleted their account).</p>}
      {pii && (
        <dl className="text-xs">
          <dt className="inline text-[var(--muted)]">Pickup </dt><dd className="inline">{pii.pickup_label ?? '—'}</dd><br />
          <dt className="inline text-[var(--muted)]">Drop-off </dt><dd className="inline">{pii.dropoff_label ?? '—'}</dd><br />
          <dt className="inline text-[var(--muted)]">Driver </dt><dd className="inline">{pii.driver_name ?? '—'} · {pii.plate ?? '—'}</dd>
          {pii.lat != null && pii.lng != null && <><br /><dt className="inline text-[var(--muted)]">Last position </dt><dd className="inline">{pii.lat}, {pii.lng} ({when(pii.position_at)})</dd></>}
        </dl>
      )}
    </div>
  )
}
