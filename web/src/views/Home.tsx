import { useEffect, useState } from 'react'
import type { RecurringRide, View } from '../types'
import { DAYS } from '../types'
import { deleteRide, listRides, saveRide } from '../storage'
import RoleToggle from '../components/RoleToggle'
import AuthChip from '../components/AuthChip'
import { useAuth } from '../lib/useAuth'
import { app } from '../lib/app'

interface HomeProps {
  onNavigate: (view: View) => void
}

export default function Home({ onNavigate }: HomeProps) {
  const auth = useAuth()
  const [rides, setRides] = useState<RecurringRide[]>([])

  useEffect(() => {
    setRides(listRides())
  }, [])

  const togglePause = (ride: RecurringRide) => {
    const next = { ...ride, paused: !ride.paused }
    saveRide(next)
    setRides(listRides())
  }

  const remove = (id: string) => {
    deleteRide(id)
    setRides(listRides())
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Loopride</h1>
          <div className="flex items-center gap-3">
            <AuthChip
              loading={auth.loading}
              user={auth.user}
              onSignIn={(provider) => app.auth.signIn(provider)}
              onSignOut={auth.signOut}
            />
            <RoleToggle role="rider" onNavigate={onNavigate} />
          </div>
        </div>
        <div className="flex items-baseline justify-between">
          <p className="text-sm text-[var(--muted)]">Your recurring rides.</p>
          <button
            onClick={() => onNavigate({ name: 'new' })}
            className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
          >
            + New
          </button>
        </div>
        {!auth.loading && !auth.user && (
          <p className="mt-3 rounded-xl bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--ink)]">
            Sign in to track trips live across devices. Without it, live tracking only works
            in tabs of this browser.
          </p>
        )}
      </header>

      {rides.length === 0 ? (
        <div className="rounded-3xl border border-[var(--line)] p-10 text-center">
          <p className="display-font text-xl text-[var(--ink)]">No rides yet</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Set up a recurring ride and a driver. Same route, same time, every week.
          </p>
          <button
            onClick={() => onNavigate({ name: 'new' })}
            className="mt-6 rounded-2xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Create your first ride
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {rides.map((ride) => (
            <li
              key={ride.id}
              className="rounded-2xl border border-[var(--line)] p-5 transition-colors hover:bg-[var(--accent-soft)]"
            >
              <button
                onClick={() => onNavigate({ name: 'trip', rideId: ride.id })}
                className="block w-full text-left"
              >
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-semibold text-[var(--ink)]">
                    {ride.pickup} → {ride.dropoff}
                  </p>
                  <p className="text-sm font-medium tabular-nums text-[var(--ink)]">{ride.time}</p>
                </div>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  with {ride.driverName} ·{' '}
                  {DAYS.filter((d) => ride.days.includes(d.id))
                    .map((d) => d.label)
                    .join(', ')}
                  {ride.paused ? ' · paused' : ''}
                </p>
              </button>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => togglePause(ride)}
                  className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]"
                >
                  {ride.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  onClick={() => remove(ride.id)}
                  className="rounded-xl border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--error)] hover:bg-[var(--accent-soft)]"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
