import { useLocation } from 'wouter'
import RoleToggle from '../components/RoleToggle'
import AuthChip from '../components/AuthChip'
import DriverOffers from '../components/DriverOffers'
import NotificationBell from '../components/NotificationBell'
import { useAuth } from '../lib/useAuth'
import { app } from '../lib/app'

export default function DriverHome() {
  const auth = useAuth()
  const [, setLocation] = useLocation()

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-extrabold tracking-[-0.06em] text-[var(--ink)]">RideShare <span className="text-[var(--accent)]">Drive</span></h1>
          <div className="flex flex-wrap items-center gap-2">
            <NotificationBell signedIn={Boolean(auth.user)} />
            <AuthChip loading={auth.loading} user={auth.user} onSignIn={(provider) => app.auth.signIn(provider)} onSignOut={auth.signOut} />
            <RoleToggle role="driver" />
          </div>
        </div>
        <p className="text-sm text-[var(--muted)]">Nearby trip requests and your current trip.</p>
        <button onClick={() => setLocation('/driver/onboarding')} className="mr-2 mt-3 rounded-full border border-[var(--line)] px-3 py-1 text-xs font-bold text-[var(--ink)] hover:bg-[var(--accent-soft)]">Driver application and vehicles</button>
        <button onClick={() => setLocation('/account')} className="mt-3 rounded-full border border-[var(--line)] px-3 py-1 text-xs font-bold text-[var(--ink)] hover:bg-[var(--accent-soft)]">Notification settings</button>
      </header>

      {auth.user ? <DriverOffers /> : !auth.loading && (
        <p role="note" className="rounded-xl bg-[var(--accent-soft)] px-4 py-3 text-xs leading-5 text-[var(--ink)]">Sign in and get approved to receive trip requests.</p>
      )}
      <div className="rounded-3xl border border-[var(--line)] p-10 text-center text-sm text-[var(--muted)]">
        Go available from your driver application page to receive nearby requests. New requests appear here.
      </div>
    </div>
  )
}
