import { useState } from 'react'
import { useLocation } from 'wouter'
import { renderNotification } from '../lib/notifications'
import { useNotifications } from '../lib/useNotifications'

/** Bell with an unread count and the inbox. Each item opens the trip it is about. */
export default function NotificationBell({ signedIn }: { signedIn: boolean }) {
  const { items, prefs, unread, markRead } = useNotifications(signedIn)
  const [open, setOpen] = useState(false)
  const [, setLocation] = useLocation()
  if (!signedIn) return null

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} className="relative rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]">
        🔔
        {unread > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--error)] px-1 text-[10px] font-bold text-white">{unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 z-20 mt-2 w-72 rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-2 shadow-lg">
          {items.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-[var(--muted)]">No notifications yet.</p>
          ) : (
            <>
              <ul className="max-h-80 overflow-y-auto">
                {items.map((n) => {
                  const text = renderNotification(n, prefs.locale)
                  return (
                    <li key={n.id}>
                      <button
                        onClick={() => {
                          void markRead(n.id)
                          setOpen(false)
                          setLocation(n.link)
                        }}
                        className={`block w-full rounded-xl px-3 py-2 text-left hover:bg-[var(--accent-soft)] ${n.readAt === null ? '' : 'opacity-60'}`}
                      >
                        <span className="block text-xs font-bold text-[var(--ink)]">{text.title}</span>
                        <span className="block text-xs text-[var(--muted)]">{text.body}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              {unread > 0 && <button onClick={() => void markRead()} className="mt-1 w-full rounded-xl px-3 py-2 text-xs font-bold text-[var(--accent)]">Mark all read</button>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
