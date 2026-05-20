import { dismissToast, useToasts } from '../lib/toast'

export default function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl bg-[var(--ink)] px-4 py-3 text-sm font-medium text-[var(--paper)] shadow-lg"
        >
          <span className="truncate">{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.onClick()
                dismissToast(t.id)
              }}
              className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white"
            >
              {t.action.label}
            </button>
          )}
          <button
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="rounded-md px-1 text-xs text-[var(--paper)]/60 hover:text-[var(--paper)]"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
