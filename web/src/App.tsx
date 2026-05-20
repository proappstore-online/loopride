// Published on https://proappstore.online — visit for more pro apps.
import { useEffect, useRef } from 'react'
import { Route, Switch, useLocation } from 'wouter'
import Home from './views/Home'
import NewRide from './views/NewRide'
import Trip from './views/Trip'
import DriverHome from './views/DriverHome'
import DriverTrip from './views/DriverTrip'
import { getRole, setRole } from './lib/mode'
import { clearShareHash, decodeShareHash } from './lib/share'
import { getRide, saveRide } from './storage'
import { useRideSync } from './lib/rideSync'

interface ShareResult {
  rideId: string
}

function consumeShareHash(): ShareResult | null {
  if (typeof window === 'undefined') return null
  const incoming = decodeShareHash(window.location.hash)
  if (!incoming) return null
  if (!getRide(incoming.id)) {
    saveRide(incoming)
  }
  clearShareHash()
  setRole('driver')
  return { rideId: incoming.id }
}

export default function App() {
  const [location, setLocation] = useLocation()
  // Guards the one-shot first-paint navigation so StrictMode's double-invoke
  // (or any other remount) doesn't run it twice — the second pass would see
  // a cleared hash + getRole() === 'driver' and clobber /driver/:id with a
  // plain /driver redirect.
  const bootRedirected = useRef(false)

  useRideSync()

  // First-paint navigation. Three cases, in priority order:
  //   1. URL has #ride= → import the ride and jump to /driver/:id
  //   2. URL is "/" and the saved role is driver → redirect to /driver
  //   3. Otherwise leave the URL alone
  // Plus a hashchange listener so a share hash arriving later still works.
  useEffect(() => {
    if (!bootRedirected.current) {
      bootRedirected.current = true
      const shareResult = consumeShareHash()
      if (shareResult) {
        setLocation(`/driver/${shareResult.rideId}`)
      } else if (location === '/' && getRole() === 'driver') {
        setLocation('/driver', { replace: true })
      }
    }

    const onHash = () => {
      const result = consumeShareHash()
      if (result) setLocation(`/driver/${result.rideId}`)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/new" component={NewRide} />
      <Route path="/trip/:rideId">
        {(params) => <Trip rideId={params.rideId} />}
      </Route>
      <Route path="/driver" component={DriverHome} />
      <Route path="/driver/:rideId">
        {(params) => <DriverTrip rideId={params.rideId} />}
      </Route>
      <Route>
        <NotFound />
      </Route>
    </Switch>
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
