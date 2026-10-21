import { useEffect, useState } from 'react'
import { DEFAULT_PREFS, EMAIL_CONSENT_TEXT, LOCALES, SMS_NOTE, enablePush, loadPrefs, savePrefs, type Locale, type Prefs } from '../lib/notifications'
import { showToast } from '../lib/toast'

/** Push, language, and the opt-in email fallback. Nothing is on without an explicit choice except in-app notifications. */
export default function NotificationSettings() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    loadPrefs().then((p) => live && setPrefs(p), () => undefined)
    return () => {
      live = false
    }
  }, [])

  const update = async (next: Prefs) => {
    setBusy(true)
    try {
      if (next.push && !prefs.push) {
        if (!(await enablePush())) showToast({ message: 'Push notifications are blocked in this browser. You will still see them in the app.' })
      }
      await savePrefs(next)
      setPrefs({ ...next, emailConsentAt: next.emailFallback ? (prefs.emailConsentAt ?? Date.now()) : null })
    } catch {
      showToast({ message: "Couldn't save your notification settings" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Notifications" className="space-y-3">
      <h2 className="mb-3 text-base font-extrabold tracking-[-0.03em] text-[var(--ink)]">Notifications</h2>
      <label className="block text-xs font-bold text-[var(--ink)]">Language
        <select className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" value={prefs.locale} disabled={busy} onChange={(e) => void update({ ...prefs, locale: e.target.value as Locale })}>
          {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm text-[var(--ink)]">
        <input type="checkbox" className="mt-1" checked={prefs.push} disabled={busy} onChange={(e) => void update({ ...prefs, push: e.target.checked })} />
        Push notifications for trip updates
      </label>
      <label className="flex items-start gap-2 text-sm text-[var(--ink)]">
        <input type="checkbox" className="mt-1" checked={prefs.emailFallback} disabled={busy} onChange={(e) => void update({ ...prefs, emailFallback: e.target.checked })} />
        <span>{EMAIL_CONSENT_TEXT}</span>
      </label>
      {prefs.emailFallback && prefs.emailConsentAt && <p className="text-xs text-[var(--muted)]">You agreed on {new Date(prefs.emailConsentAt).toLocaleDateString()}.</p>}
      <p className="text-xs text-[var(--muted)]">{SMS_NOTE}</p>
    </section>
  )
}
