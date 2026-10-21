import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '../lib/useAuth'
import { showToast } from '../lib/toast'
import {
  decisionsFor,
  hasOpsRole,
  listApplications,
  reviewApplication,
  type ApplicationStatus,
  type ApplicationSummary,
  type Decision,
} from '../lib/driverOnboarding'

const FILTERS: ApplicationStatus[] = ['submitted', 'approved', 'rejected', 'suspended']
const VERB: Record<Decision, string> = { approved: 'Approve', rejected: 'Reject', suspended: 'Suspend' }

/** Operations: review driver applications. The ops app role is re-checked server-side on every call. */
export default function Ops() {
  const auth = useAuth()
  const [, setLocation] = useLocation()
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [filter, setFilter] = useState<ApplicationStatus>('submitted')
  const [rows, setRows] = useState<ApplicationSummary[]>([])
  const [reasons, setReasons] = useState<Record<string, string>>({})

  useEffect(() => {
    if (auth.loading) return
    if (!auth.user) return setAllowed(false)
    hasOpsRole().then(setAllowed)
  }, [auth.loading, auth.user])

  const refresh = useCallback(() => listApplications(filter).then(setRows, () => showToast({ message: "Couldn't load applications" })), [filter])
  useEffect(() => {
    if (allowed) void refresh()
  }, [allowed, refresh])

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

  if (allowed === null) return null
  if (!allowed) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="text-sm font-bold text-[var(--ink)]">Operations access required</p>
        <button onClick={() => setLocation('/')} className="mt-4 rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white">Back to home</button>
      </div>
    )
  }

  return (
    <div className="mx-auto min-h-[100dvh] max-w-2xl space-y-4 px-4 pb-10 pt-5 sm:px-6">
      <h1 className="text-xl font-extrabold tracking-[-0.06em] text-[var(--ink)]">Driver applications</h1>
      <div role="tablist" className="flex gap-2">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`rounded-full border px-3 py-1 text-xs font-bold capitalize ${filter === f ? 'border-[var(--ink)] bg-[var(--ink)] text-white' : 'border-[var(--line)] text-[var(--ink)]'}`}>{f}</button>
        ))}
      </div>
      {rows.length === 0 && <p className="text-xs text-[var(--muted)]">No {filter} applications.</p>}
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.user_id} className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4">
            <p className="text-sm font-bold text-[var(--ink)]">{row.full_name ?? row.user_id}</p>
            <p className="text-xs text-[var(--muted)]">
              {row.phone} · Licence …{row.licence_last4} ({row.licence_region}), expires {row.licence_expires} · {row.vehicle_count} vehicle(s)
            </p>
            {decisionsFor(row.status).length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input aria-label={`Reason for ${row.full_name ?? row.user_id}`} placeholder="Reason (required to reject or suspend)" className="min-w-0 flex-1 rounded-xl border border-[var(--line)] px-3 py-1.5 text-xs" value={reasons[row.user_id] ?? ''} onChange={(e) => setReasons({ ...reasons, [row.user_id]: e.target.value })} />
                {decisionsFor(row.status).map((d) => (
                  <button key={d} onClick={() => decide(row, d)} className="rounded-xl border border-[var(--line)] px-3 py-1.5 text-xs font-bold text-[var(--ink)]">{VERB[d]}</button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
