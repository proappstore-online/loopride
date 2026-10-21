import { useCallback, useEffect, useState } from 'react'
import { showToast } from '../../lib/toast'
import {
  PAUSE_REASONS, RUNBOOK_URL, isDispatchPaused, loadAlerts, loadErrors, loadInvariants, loadMetrics, setDispatchPaused,
  type ErrorGroup, type HealthAlert, type HealthMetric, type Invariant,
} from '../../lib/opsConsole'
import { Empty, Note, ReasonSelect, box, danger, field, primary } from './ui'
import { when } from './format'

export const REFRESH_MS = 30_000
const WINDOWS = [15, 60, 120]

/** Live health: which alerts are firing, per-domain call counters, inconsistent states, grouped errors, and the dispatch switch. */
export default function HealthPanel() {
  const [windowMin, setWindowMin] = useState(15)
  const [alerts, setAlerts] = useState<HealthAlert[] | null>(null)
  const [metrics, setMetrics] = useState<HealthMetric[]>([])
  const [invariants, setInvariants] = useState<Invariant[]>([])
  const [errors, setErrors] = useState<ErrorGroup[]>([])
  const [failed, setFailed] = useState(false)
  const [paused, setPaused] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, m, i, e, p] = await Promise.all([loadAlerts(windowMin), loadMetrics(windowMin), loadInvariants(), loadErrors(windowMin), isDispatchPaused()])
      setAlerts(a); setMetrics(m); setInvariants(i); setErrors(e); setPaused(p); setFailed(false); setRefreshedAt(Date.now())
    } catch {
      setFailed(true)
    }
  }, [windowMin])
  useEffect(() => {
    void load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  const firing = (alerts ?? []).filter((a) => a.firing === 1)

  return (
    <section aria-label="Health" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className={`text-sm font-bold ${failed || firing.some((a) => a.severity === 'critical') ? 'text-[var(--error)]' : 'text-[var(--ink)]'}`}>
          {failed ? "Couldn't read health. Treat this as an incident until it loads." : alerts === null ? 'Checking…' : firing.length === 0 ? 'All checks passing' : `${firing.length} alert${firing.length === 1 ? '' : 's'} firing`}
        </p>
        <label className="flex items-center gap-2 text-xs font-bold text-[var(--ink)]">Window
          <select className={`${field} w-auto`} value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>{WINDOWS.map((w) => <option key={w} value={w}>{w} min</option>)}</select>
        </label>
      </div>
      {refreshedAt && <p className="text-xs text-[var(--muted)]">Updated {when(refreshedAt)}; refreshes every 30 seconds.</p>}

      <ul aria-label="Alerts" className="space-y-2">
        {(alerts ?? []).map((a) => (
          <li key={a.code} className={`${box} ${a.firing ? (a.severity === 'critical' ? 'border-[var(--error)]' : 'border-[var(--accent)]') : 'opacity-70'}`}>
            <p className="flex items-baseline justify-between gap-3 text-sm font-bold text-[var(--ink)]">
              <span>{a.firing ? (a.severity === 'critical' ? '● ' : '◐ ') : '○ '}{a.message}</span>
              <span className="text-xs font-semibold text-[var(--muted)]">{a.firing ? a.severity : 'ok'}</span>
            </p>
            <p className="text-xs text-[var(--muted)]">{a.code} · now {a.value} · fires at {a.threshold}</p>
            {a.firing === 1 && <a className="mt-1 inline-block text-xs font-bold text-[var(--accent)] underline" href={RUNBOOK_URL(a.runbook)} target="_blank" rel="noreferrer">Runbook: {a.runbook.replace('-', ' ')}</a>}
          </li>
        ))}
      </ul>

      <DispatchSwitch paused={paused} onChanged={load} />

      <div>
        <h3 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-[var(--muted)]">Calls by area</h3>
        <table className="w-full text-left text-xs text-[var(--ink)]">
          <thead className="text-[var(--muted)]"><tr><th>Area</th><th>Calls</th><th>Failed</th><th>Slow</th><th>Avg ms</th><th>People</th></tr></thead>
          <tbody>{metrics.map((m) => <tr key={m.domain}><td className="font-bold">{m.domain}</td><td>{m.calls}</td><td>{m.errors}</td><td>{m.slow}</td><td>{m.avg_latency_ms}</td><td>{m.people}</td></tr>)}</tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-[var(--muted)]">Inconsistent states</h3>
        {invariants.length === 0 ? <Empty>None. Every trip, ride and offer agrees.</Empty> : (
          <ul className="space-y-1 text-xs">{invariants.map((i, n) => <li key={n} className="rounded-xl border border-[var(--error)] px-3 py-2"><b>{i.code.replaceAll('_', ' ')}</b> · {i.ref} <span className="text-[var(--muted)]">{i.detail}</span></li>)}</ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-[var(--muted)]">Errors reported by the app</h3>
        {errors.length === 0 ? <Empty>No errors in this window.</Empty> : (
          <ul className="space-y-1 text-xs">{errors.map((e) => <li key={`${e.domain}${e.code}${e.severity}`} className="rounded-xl border border-[var(--line)] px-3 py-2"><b>{e.domain}</b> · {e.code.replaceAll('_', ' ')} · {e.severity} · {e.n}× by {e.people} {e.people === 1 ? 'person' : 'people'} · last {when(e.last_at)}{e.action ? ` · ${e.action}` : ''}{e.status ? ` · HTTP ${e.status}` : ''}{e.sample_trip ? ` · e.g. ${e.sample_trip}` : ''}</li>)}</ul>
        )}
      </div>
    </section>
  )
}

function DispatchSwitch({ paused, onChanged }: { paused: boolean; onChanged: () => void }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await setDispatchPaused(!paused, reason, note)
      showToast({ message: paused ? 'Dispatch resumed' : 'Dispatch paused' })
      setNote(''); setReason('')
      onChanged()
    } catch {
      showToast({ message: 'That action was refused' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div role="group" aria-label="Dispatch switch" className={`${box} space-y-3`}>
      <p className="text-sm font-bold text-[var(--ink)]">Ride dispatch is {paused ? 'PAUSED' : 'running'}</p>
      <p className="text-xs text-[var(--muted)]">Pausing refuses new ride requests with a clear message. Searches already running, active trips, tracking and notifications are not affected. Every change is audited.</p>
      {!paused && <ReasonSelect reasons={PAUSE_REASONS} value={reason} onChange={setReason} />}
      <Note value={note} onChange={setNote} />
      <button className={paused ? primary : danger} disabled={busy || !note.trim() || (!paused && !reason)} onClick={run}>{paused ? 'Resume dispatch' : 'Pause dispatch'}</button>
    </div>
  )
}
