import { type ReactNode } from 'react'
import type { Reason } from '../../lib/opsConsole'

export const box = 'rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4'
export const field = 'w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)]'
export const primary = 'rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-bold text-white disabled:opacity-50'
export const outline = 'rounded-xl border border-[var(--line)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] disabled:opacity-50'
export const danger = 'rounded-xl bg-[var(--error)] px-4 py-2 text-xs font-bold text-white disabled:opacity-50'

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-bold text-[var(--ink)]">{label}<div className="mt-1">{children}</div></label>
}

export function ReasonSelect({ label = 'Reason', reasons, value, onChange }: { label?: string; reasons: Reason[]; value: string; onChange: (v: string) => void }) {
  return (
    <Labeled label={label}>
      <select className={field} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a reason…</option>
        {reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
      </select>
    </Labeled>
  )
}

export function Note({ value, onChange, label = 'Note' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return <Labeled label={label}><textarea className={field} rows={2} maxLength={200} value={value} onChange={(e) => onChange(e.target.value)} /></Labeled>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-[var(--line)] px-4 py-6 text-center text-xs text-[var(--muted)]">{children}</p>
}
