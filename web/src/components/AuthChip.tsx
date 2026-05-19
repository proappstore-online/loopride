import type { User } from '@proappstore/sdk/hooks'

export type SignInProvider = 'github' | 'google'

interface AuthChipProps {
  loading: boolean
  user: User | null
  onSignIn: (provider: SignInProvider) => void
  onSignOut: () => void
}

export default function AuthChip({ loading, user, onSignIn, onSignOut }: AuthChipProps) {
  if (loading) {
    return <span className="text-xs text-[var(--muted)]">…</span>
  }
  if (!user) {
    return (
      <div className="inline-flex items-center gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          Sign in
        </span>
        <button
          onClick={() => onSignIn('google')}
          aria-label="Sign in with Google"
          className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        >
          Google
        </button>
        <button
          onClick={() => onSignIn('github')}
          aria-label="Sign in with GitHub"
          className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        >
          GitHub
        </button>
      </div>
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
