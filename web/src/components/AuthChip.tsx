import type { User } from '@proappstore/sdk/hooks'

interface AuthChipProps {
  loading: boolean
  user: User | null
  onSignIn: () => void
  onSignOut: () => void
}

export default function AuthChip({ loading, user, onSignIn, onSignOut }: AuthChipProps) {
  if (loading) {
    return <span className="text-xs text-[var(--muted)]">…</span>
  }
  if (!user) {
    return (
      <button
        onClick={onSignIn}
        className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]"
      >
        Sign in
      </button>
    )
  }
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-xs font-medium text-[var(--ink)]">@{user.login}</span>
      <button
        onClick={onSignOut}
        className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)] hover:text-[var(--ink)]"
      >
        Sign out
      </button>
    </div>
  )
}
