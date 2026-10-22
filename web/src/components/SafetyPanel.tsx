import { useRef, useState } from 'react'
import { SAFETY_CATEGORIES, SAFETY_COPY, isUrgent, newReportKey, reportExists, submitSafetyReport } from '../lib/safety'
import { showToast } from '../lib/toast'

interface Props {
  /** The rider whose trip this is (the signed-in rider, or the rider named in the driver's trip). */
  riderId: string
  tripId: string
  /** Who is reporting, so the wording speaks about the right person. */
  role: 'rider' | 'driver'
  onClose: () => void
}

/**
 * In-trip safety: emergency guidance first, then a report that goes to staff with the trip attached.
 * The guidance comes first on purpose; a report is not a way to get help.
 */
export default function SafetyPanel({ riderId, tripId, role, onClose }: Props) {
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<'urgent' | 'standard' | null>(null)
  // One key per sheet, so tapping Send again after a timeout is a retry, not a second report.
  const key = useRef(newReportKey())

  const send = async () => {
    setBusy(true)
    try {
      await submitSafetyReport({ riderId, tripId, category, note, key: key.current })
      // The server ignores reports it refuses (wrong person, ended trip, rate limit) without an error.
      if (!(await reportExists(key.current))) throw new Error('not recorded')
      setSent(isUrgent(category) ? 'urgent' : 'standard')
    } catch {
      showToast({ message: "Couldn't send your report. Try again." })
      setBusy(false)
    }
  }

  const other = role === 'rider' ? 'the driver' : 'the rider'
  return (
    <div role="group" aria-label="Safety" className="mt-4 space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--accent-soft)] p-4">
      <p role="alert" className="text-sm font-bold text-[var(--error)]">{SAFETY_COPY.emergency}</p>
      <p className="text-xs text-[var(--muted)]">{SAFETY_COPY.limits}</p>
      {sent ? (
        <>
          <p role="status" className="text-sm font-semibold text-[var(--ink)]">{sent === 'urgent' ? SAFETY_COPY.sentUrgent : SAFETY_COPY.sent}</p>
          <p className="text-xs text-[var(--muted)]">{SAFETY_COPY.after}</p>
          <button onClick={onClose} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Done</button>
        </>
      ) : (
        <>
          <label className="block text-xs font-bold text-[var(--ink)]">What happened with {other}?
            <select className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choose…</option>
              {SAFETY_CATEGORIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
          <label className="block text-xs font-bold text-[var(--ink)]">Details (optional)
            <textarea className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="text-xs text-[var(--muted)]">Staff see this trip's status and the driver's last shared position, if there is one. Names and addresses are opened only with a logged reason.</p>
          <div className="flex gap-2">
            <button onClick={send} disabled={busy || !category} className="rounded-2xl bg-[var(--error)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">Send safety report</button>
            <button onClick={onClose} className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]">Close</button>
          </div>
        </>
      )}
    </div>
  )
}
