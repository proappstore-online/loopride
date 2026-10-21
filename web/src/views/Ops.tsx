import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '../lib/useAuth'
import { hasRole } from '../lib/opsConsole'
import DriversPanel from './ops/DriversPanel'
import TripsPanel from './ops/TripsPanel'
import { AuditPanel, DisputesPanel, EscalationsPanel, RefundsPanel } from './ops/QueuePanels'

const TABS = [
  { id: 'trips', label: 'Trips' },
  { id: 'drivers', label: 'Drivers' },
  { id: 'disputes', label: 'Disputes' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'escalations', label: 'Escalations' },
  { id: 'audit', label: 'Audit' },
] as const
type Tab = (typeof TABS)[number]['id']

/**
 * Operations console for staff. Everything here is re-checked on the server: the
 * ops app role gates each action, personal data needs ops_pii plus a logged reason,
 * and every support action needs a reason code and is audited.
 */
export default function Ops() {
  const auth = useAuth()
  const [, setLocation] = useLocation()
  const [role, setRole] = useState<{ ops: boolean; pii: boolean } | null>(null)
  const [tab, setTab] = useState<Tab>('trips')

  useEffect(() => {
    if (auth.loading) return
    if (!auth.user) return setRole({ ops: false, pii: false })
    Promise.all([hasRole('ops'), hasRole('ops_pii')]).then(([ops, pii]) => setRole({ ops, pii }))
  }, [auth.loading, auth.user])

  if (role === null) return null
  if (!role.ops) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="text-sm font-bold text-[var(--ink)]">Operations access required</p>
        <button onClick={() => setLocation('/')} className="mt-4 rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white">Back to home</button>
      </div>
    )
  }

  return (
    <div className="mx-auto min-h-[100dvh] max-w-3xl space-y-4 px-4 pb-10 pt-5 sm:px-6">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-extrabold tracking-[-0.06em] text-[var(--ink)]">Operations</h1>
        <span className="text-xs text-[var(--muted)]">{role.pii ? 'Can open personal details (logged)' : 'Personal details are hidden'}</span>
      </header>
      <div role="tablist" aria-label="Console sections" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded-full border px-3 py-1 text-xs font-bold ${tab === t.id ? 'border-[var(--ink)] bg-[var(--ink)] text-white' : 'border-[var(--line)] text-[var(--ink)]'}`}>{t.label}</button>
        ))}
      </div>
      {tab === 'trips' && <TripsPanel canSeePii={role.pii} />}
      {tab === 'drivers' && <DriversPanel canSeePii={role.pii} />}
      {tab === 'disputes' && <DisputesPanel />}
      {tab === 'refunds' && <RefundsPanel />}
      {tab === 'escalations' && <EscalationsPanel />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  )
}
