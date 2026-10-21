import { useCallback, useEffect, useRef, useState } from 'react'
import { deliverPending, loadInbox, loadPrefs, markRead, renderNotification, DEFAULT_PREFS, type Notification, type Prefs } from './notifications'
import { showToast } from './toast'

export const POLL_MS = 15_000

/**
 * The signed-in user's inbox. Polls, delivers anything this user owes to others,
 * and shows a toast for each notification that arrives while the app is open.
 */
export function useNotifications(enabled: boolean) {
  const [items, setItems] = useState<Notification[]>([])
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const seen = useRef<Set<string> | null>(null)
  const prefsRef = useRef<Prefs>(DEFAULT_PREFS)

  const refresh = useCallback(async () => {
    try {
      const [inbox, p] = await Promise.all([loadInbox(), loadPrefs()])
      prefsRef.current = p
      setPrefs(p)
      setItems(inbox)
      if (seen.current === null) {
        // First load: what is already there is not news.
        seen.current = new Set(inbox.map((n) => n.id))
      } else {
        for (const n of inbox) {
          if (seen.current.has(n.id) || n.readAt !== null) continue
          seen.current.add(n.id)
          showToast({ message: renderNotification(n, p.locale).title })
        }
      }
    } catch {
      /* offline: keep what we have */
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    void deliverPending().catch(() => undefined)
    const timer = setInterval(() => {
      void deliverPending().catch(() => undefined)
      void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, refresh])

  const read = useCallback(
    async (id?: string) => {
      await markRead(id).catch(() => undefined)
      await refresh()
    },
    [refresh],
  )

  return { items, prefs, unread: items.filter((n) => n.readAt === null).length, markRead: read, refresh }
}
