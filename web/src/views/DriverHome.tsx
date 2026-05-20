import { useEffect, useState } from 'react'
import type { RecurringRide, View } from '../types'
import { DAYS } from '../types'
import { listRides } from '../storage'
import RoleToggle from '../components/RoleToggle'
import AuthChip from '../components/AuthChip'
import { useAuth } from '../lib/useAuth'
import { app } from '../lib/app'

interface DriverHomeProps {
  onNavigate: (view: View) => void
}

export default function DriverHome({ onNavigate }: DriverHomeProps) {
  const auth = useAuth()
  const [rides, setRides] = useState<RecurringRide[]>([])

  useEffect(() => {
    setRides(listRides())
    const onSync = () => setRides(listRides())
    window.addEventListener('loopride:rides-synced', onSync)
    return () => window.removeEventListener('loopride:rides-synced', onSync)
  }, [])

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Loopride · Driver</h1>
          <div className="flex items-center gap-3">
            <AuthChip
              loading={auth.loading}
              user={auth.user}
              onSignIn={(provider) => app.auth.signIn(provider)}
              onSignOut={auth.signOut}
            />
            <RoleToggle role="driver" onNavigate={onNavigate} />
          </div>
        </div>
        <p className="text-sm text-[var(--muted)]">Trips you can drive.</p>
      </header>

      {rides.length === 0 ? (
        <div className="rounded-3xl border border-[var(--line)] p-10 text-center text-sm text-[var(--muted)]">
          No trips scheduled yet. Riders set them up in the Rider tab.
        </div>
      ) : (
        <ul className="space-y-3">
          {rides.map((ride) => {
            const ready = ride.pickupCoord && ride.dropoffCoord
            return (
              <li
                key={ride.id}
                className="rounded-2xl border border-[var(--line)] p-5 transition-colors hover:bg-[var(--accent-soft)]"
              >
                <button
                  onClick={() => ready && onNavigate({ name: 'driver-trip', rideId: ride.id })}
                  disabled={!ready}
                  className="block w-full text-left disabled:opacity-50"
                >
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-semibold text-[var(--ink)]">
                      {ride.pickup} → {ride.dropoff}
                    </p>
                    <p className="text-sm font-medium tabular-nums text-[var(--ink)]">{ride.time}</p>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Driver: {ride.driverName} ·{' '}
                    {DAYS.filter((d) => ride.days.includes(d.id))
                      .map((d) => d.label)
                      .join(', ')}
                    {!ready ? ' · missing coords' : ''}
                  </p>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
