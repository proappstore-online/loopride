// Published on https://proappstore.online — visit for more pro apps.
import { useEffect, useRef } from 'react'
import { Route, Switch, useLocation } from 'wouter'
import Home from './views/Home'
import NewRide from './views/NewRide'
import Trip from './views/Trip'
import DriverHome from './views/DriverHome'
import DriverTrip from './views/DriverTrip'
import Account from './views/Account'
import DriverOnboarding from './views/DriverOnboarding'
import Ops from './views/Ops'
import { getRole } from './lib/mode'
import { useRideSync } from './lib/rideSync'
import { runRetention } from './lib/privacy'
import { useAuth } from './lib/useAuth'

export default function App() {
  const [location, setLocation] = useLocation()
  const redirected = useRef(false)

  useRideSync()

  // Backstop for data expiry: other actions already purge as they run, this covers quiet periods.
  const auth = useAuth()
  const signedIn = Boolean(auth.user)
  useEffect(() => {
    if (signedIn) void runRetention()
  }, [signedIn])

  // A returning driver lands on the driver home instead of the rider home.
  useEffect(() => {
    if (redirected.current) return
    redirected.current = true
    if (location === '/' && getRole() === 'driver') setLocation('/driver', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // After a screen change, announce it: set the tab title from the heading and move focus to the content.
  const main = useRef<HTMLElement | null>(null)
  const shown = useRef<string | null>(null)
  useEffect(() => {
    const heading = main.current?.querySelector('h1')?.textContent?.trim()
    document.title = heading ? `${heading} — RideShare` : 'RideShare — rides on your schedule'
    // Only a real change of screen moves focus (the first render, and a repeated effect run, do not).
    const changed = shown.current !== null && shown.current !== location
    shown.current = location
    if (!changed) return
    main.current?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [location])

  return (
    <>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); main.current?.focus() }}>Skip to content</a>
      <main id="main" ref={main} tabIndex={-1}>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/new" component={NewRide} />
          <Route path="/account" component={Account} />
          <Route path="/trip/:rideId">
            {(params) => <Trip rideId={params.rideId} />}
          </Route>
          <Route path="/driver" component={DriverHome} />
          <Route path="/driver/onboarding" component={DriverOnboarding} />
          <Route path="/ops" component={Ops} />
          <Route path="/driver/trip/:riderId/:rideId">
            {(params) => <DriverTrip riderId={params.riderId} rideId={params.rideId} />}
          </Route>
          <Route>
            <NotFound />
          </Route>
        </Switch>
      </main>
    </>
  )
}

function NotFound() {
  const [, setLocation] = useLocation()
  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="display-font text-2xl font-bold text-[var(--ink)]">Page not found</h1>
      <button
        onClick={() => setLocation('/')}
        className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
      >
        Back to home
      </button>
    </div>
  )
}
