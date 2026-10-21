import LocationConsent from './LocationConsent'
import { PURPOSES } from '../lib/privacy'
import { RETENTION_SUMMARY } from '../lib/privacyInventory'
import { useLocationConsent } from '../lib/useLocationConsent'

function Purpose({ purpose }: { purpose: (typeof PURPOSES)[number]['purpose'] }) {
  const consent = useLocationConsent(purpose)
  return <LocationConsent purpose={purpose} state={consent.state} failed={consent.failed} onGrant={consent.grant} onWithdraw={consent.withdraw} />
}

/** Account page: the location choices (drivers) and how long short-lived data is kept. */
export default function PrivacySettings() {
  return (
    <section aria-label="Privacy" className="space-y-3">
      <h2 className="mb-3 text-base font-extrabold tracking-[-0.03em] text-[var(--ink)]">Privacy</h2>
      <p className="text-xs leading-5 text-[var(--muted)]">
        Riders' own addresses are used only for the rides they request. These choices apply to drivers' precise location.
      </p>
      {PURPOSES.map((p) => <Purpose key={p.purpose} purpose={p.purpose} />)}
      <div className="rounded-2xl border border-[var(--line)] p-4">
        <h3 className="text-sm font-extrabold text-[var(--ink)]">How long data is kept</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-[var(--muted)]">
          {RETENTION_SUMMARY.map((line) => <li key={line}>{line}</li>)}
          <li>Everything else is kept until you delete your account.</li>
        </ul>
      </div>
    </section>
  )
}
