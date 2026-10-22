import { useLocation } from 'wouter'
import type { RecurringRide } from '../types'
import { deleteRide, saveRide } from '../storage'
import RoleToggle from '../components/RoleToggle'
import AuthChip from '../components/AuthChip'
import NotificationBell from '../components/NotificationBell'
import { useAuth } from '../lib/useAuth'
import { useRideList } from '../lib/useRideList'
import { app } from '../lib/app'
import { showToast } from '../lib/toast'

function rideLabel(ride: RecurringRide): string {
  if (ride.bookingType === 'recurring') return `Repeats ${ride.days.map((d) => d.slice(0, 1).toUpperCase() + d.slice(1)).join(', ')}`
  if (ride.bookingType === 'scheduled') return `Scheduled for ${ride.time}`
  return ride.paused ? 'Matching paused' : ride.driverName ? `Driver: ${ride.driverName}` : 'Finding your driver'
}

export default function Home() {
  const auth = useAuth()
  const rides = useRideList()
  const [, setLocation] = useLocation()
  const active = rides.filter((ride) => ride.bookingType !== 'recurring')
  const planned = rides.filter((ride) => ride.bookingType === 'recurring')

  const remove = (ride: RecurringRide) => {
    // A matched ride is cancelled on its trip page, where the reason and any fee are shown first.
    if (ride.quoteId) return setLocation(`/trip/${ride.id}`)
    deleteRide(ride.id)
    showToast({ message: `Cancelled ride to ${ride.dropoff}`, action: { label: 'Undo', onClick: () => saveRide(ride) } })
  }

  return (
    <div className="mx-auto min-h-[100dvh] max-w-2xl px-4 pb-10 pt-5 sm:px-6">
      <header className="mb-7">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent)] text-lg text-white">↗</span>
            <h1 className="text-xl font-extrabold tracking-[-0.06em] text-[var(--ink)]">RideShare</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AuthChip loading={auth.loading} user={auth.user} onSignIn={(provider) => app.auth.signIn(provider)} onSignOut={auth.signOut} />
            <NotificationBell signedIn={Boolean(auth.user)} />
            <button onClick={() => setLocation('/account')} className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]">Account</button>
            <RoleToggle role="rider" />
          </div>
        </div>

        <button onClick={() => setLocation('/new')} className="group flex w-full items-center gap-4 rounded-2xl bg-[var(--ink)] px-5 py-5 text-left text-white shadow-sm transition-transform hover:-translate-y-0.5">
          <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-full bg-white/15 text-xl">⌕</span>
          <span><span className="block text-base font-bold">Where to?</span><span className="mt-0.5 block text-xs text-white/65">Request a ride now</span></span>
          <span aria-hidden="true" className="ml-auto text-white/60">→</span>
        </button>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button onClick={() => setLocation('/new?when=later')} className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-left text-sm font-bold text-[var(--ink)] hover:bg-[var(--accent-soft)]"><span aria-hidden="true" className="mr-2">◷</span> Reserve later</button>
          <button onClick={() => setLocation('/new?when=repeat')} className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-left text-sm font-bold text-[var(--ink)] hover:bg-[var(--accent-soft)]"><span aria-hidden="true" className="mr-2">↻</span> Set a routine</button>
        </div>
      </header>

      {!auth.loading && !auth.user && <p className="mb-6 rounded-xl bg-[var(--accent-soft)] px-4 py-3 text-xs text-[var(--ink)]">Sign in to keep your ride history and live trip tracking in sync across devices.</p>}

      <section>
        <div className="mb-3 flex items-baseline justify-between"><h2 className="text-base font-extrabold tracking-[-0.03em] text-[var(--ink)]">Your rides</h2>{active.length > 0 && <span className="text-xs text-[var(--muted)]">{active.length} active</span>}</div>
        {active.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-[var(--line)] bg-white/40 px-6 py-10 text-center"><p className="text-sm font-bold text-[var(--ink)]">Ready when you are</p><p className="mx-auto mt-2 max-w-xs text-xs leading-5 text-[var(--muted)]">Choose a destination, compare ride options, and request in a few taps.</p></div>
        ) : <ul className="space-y-3">{active.map((ride) => <RideCard key={ride.id} ride={ride} onOpen={() => setLocation(`/trip/${ride.id}`)} onCancel={() => remove(ride)} />)}</ul>}
      </section>

      {planned.length > 0 && <section className="mt-8"><h2 className="mb-3 text-base font-extrabold tracking-[-0.03em] text-[var(--ink)]">Your routine</h2><ul className="space-y-3">{planned.map((ride) => <RideCard key={ride.id} ride={ride} onOpen={() => setLocation(`/trip/${ride.id}`)} onCancel={() => remove(ride)} />)}</ul></section>}
    </div>
  )
}

function RideCard({ ride, onOpen, onCancel }: { ride: RecurringRide; onOpen: () => void; onCancel: () => void }) {
  return <li className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-[0_5px_24px_rgba(12,34,27,0.03)]">
    <button onClick={onOpen} className="block w-full text-left"><div className="flex gap-3"><div className="mt-1 flex flex-col items-center"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full border-2 border-[var(--accent)]" /><span aria-hidden="true" className="h-5 border-l border-dashed border-[var(--muted)]" /><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-[var(--ink)]" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-[var(--ink)]">{ride.dropoff}</p><p className="mt-1 truncate text-xs text-[var(--muted)]">From {ride.pickup}</p><p className="mt-2 text-xs font-semibold text-[var(--accent)]">{rideLabel(ride)}</p></div>{ride.fareCents && <p className="text-sm font-bold text-[var(--ink)]">${(ride.fareCents / 100).toFixed(2)}</p>}</div></button>
    <button onClick={onCancel} className="mt-3 text-xs font-bold text-[var(--error)] hover:underline">{ride.quoteId ? 'Manage ride' : 'Cancel ride'}</button>
  </li>
}
