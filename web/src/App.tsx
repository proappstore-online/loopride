import { useEffect, useState } from 'react'
import type { View } from './types'
import Home from './views/Home'
import NewRide from './views/NewRide'
import Trip from './views/Trip'
import DriverHome from './views/DriverHome'
import DriverTrip from './views/DriverTrip'
import { getRole, setRole } from './lib/mode'
import { clearShareHash, decodeShareHash } from './lib/share'
import { saveRide } from './storage'

function consumeShareHash(): View | null {
  if (typeof window === 'undefined') return null
  const incoming = decodeShareHash(window.location.hash)
  if (!incoming) return null
  saveRide(incoming)
  clearShareHash()
  // Whoever opens a share link is acting as the driver for that ride.
  setRole('driver')
  return { name: 'driver-trip', rideId: incoming.id }
}

function initialView(): View {
  const fromShare = consumeShareHash()
  if (fromShare) return fromShare
  return getRole() === 'driver' ? { name: 'driver-home' } : { name: 'home' }
}

export default function App() {
  const [view, setView] = useState<View>(initialView)

  useEffect(() => {
    // No-op on first paint, but ensures share-hash handling re-runs if the
    // URL changes via in-page navigation. (Most cases the constructor caught it.)
    const onHash = () => {
      const next = consumeShareHash()
      if (next) setView(next)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (view.name === 'new') return <NewRide onNavigate={setView} />
  if (view.name === 'trip') return <Trip rideId={view.rideId} onNavigate={setView} />
  if (view.name === 'driver-home') return <DriverHome onNavigate={setView} />
  if (view.name === 'driver-trip') return <DriverTrip rideId={view.rideId} onNavigate={setView} />
  return <Home onNavigate={setView} />
}
