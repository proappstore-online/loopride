import { noticeFor, type LocationPurpose } from '../lib/privacy'
import type { ConsentState } from '../lib/useLocationConsent'

/** Plain-language notice and the choice to allow or withdraw one location purpose. */
export default function LocationConsent({
  purpose,
  state,
  failed,
  onGrant,
  onWithdraw,
}: {
  purpose: LocationPurpose
  state: ConsentState
  failed: boolean
  onGrant: () => void
  onWithdraw: () => void
}) {
  const { title, notice, withdrawEffect } = noticeFor(purpose)
  const granted = state === 'granted'
  return (
    <section aria-label={title} className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4">
      <h3 className="text-sm font-extrabold text-[var(--ink)]">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--muted)]">{notice}</p>
      {failed && <p role="alert" className="mt-2 text-xs text-[var(--error)]">Couldn't save your choice. Try again.</p>}
      {state === 'loading' ? null : granted ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold text-[var(--ink)]">Allowed</span>
          <button onClick={onWithdraw} className="rounded-xl border border-[var(--line)] px-3 py-1.5 text-xs font-bold text-[var(--ink)]">Withdraw</button>
          <span className="text-xs text-[var(--muted)]">{withdrawEffect}</span>
        </div>
      ) : (
        <button onClick={onGrant} className="mt-3 rounded-xl bg-[var(--accent)] px-4 py-1.5 text-xs font-bold text-white">Allow</button>
      )}
    </section>
  )
}
