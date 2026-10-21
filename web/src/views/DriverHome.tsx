import { useLocation } from 'wouter'
import RoleToggle from '../components/RoleToggle'
import AuthChip from '../components/AuthChip'
import { useAuth } from '../lib/useAuth'
import { useRideList } from '../lib/useRideList'
import { app } from '../lib/app'
import DriverOffers from '../components/DriverOffers'

export default function DriverHome() {
  const auth = useAuth()
  const rides = useRideList()
  const [, setLocation] = useLocation()

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-extrabold tracking-[-0.06em] text-[var(--ink)]">RideShare <span className="text-[var(--accent)]">Drive</span></h1>
          <div className="flex items-center gap-3">
            <AuthChip
              loading={auth.loading}
              user={auth.user}
              onSignIn={(provider) => app.auth.signIn(provider)}
              onSignOut={auth.signOut}
            />
            <RoleToggle role="driver" />
          </div>
        </div>
        <p className="text-sm text-[var(--muted)]">Nearby trip requests and reservations.</p>
        <button onClick={() => setLocation('/driver/onboarding')} className="mt-3 rounded-full border border-[var(--line)] px-3 py-1 text-xs font-bold text-[var(--ink)] hover:bg-[var(--accent-soft)]">Driver application and vehicles</button>
      </header>

      {auth.user && <DriverOffers />}

      {rides.length === 0 ? (
        <div className="rounded-3xl border border-[var(--line)] p-10 text-center text-sm text-[var(--muted)]">
          No trip requests yet. Keep RideShare Drive open to receive nearby requests.
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
                  onClick={() => ready && setLocation(`/driver/${ride.id}`)}
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
                    {ride.bookingType === 'recurring' ? `Routine at ${ride.time}` : ride.vehicle === 'xl' ? 'RideShare XL' : ride.vehicle === 'comfort' ? 'Comfort' : 'RideShare'}
                    {ride.fareCents ? ` · $${(ride.fareCents / 100).toFixed(2)}` : ''}
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
