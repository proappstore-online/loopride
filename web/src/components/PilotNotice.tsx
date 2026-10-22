import { LAUNCH_STAGE, PILOT_NOTICE } from '../lib/launch'

/** A permanent, plain statement that the service is a pilot. Shown for as long as the launch gates are open. */
export default function PilotNotice() {
  if (LAUNCH_STAGE !== 'pilot') return null
  return (
    <aside aria-label="Pilot notice" className="bg-[var(--accent-soft)] px-4 py-2 text-center text-xs text-[var(--ink)]">
      <strong>{PILOT_NOTICE.title}.</strong> {PILOT_NOTICE.body}
    </aside>
  )
}
