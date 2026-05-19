import { useState } from 'react'
import type { View } from './types'
import Home from './views/Home'
import NewRide from './views/NewRide'
import Trip from './views/Trip'
import DriverHome from './views/DriverHome'
import DriverTrip from './views/DriverTrip'
import { getRole } from './lib/mode'

function initialView(): View {
  return getRole() === 'driver' ? { name: 'driver-home' } : { name: 'home' }
}

export default function App() {
  const [view, setView] = useState<View>(initialView)

  if (view.name === 'new') return <NewRide onNavigate={setView} />
  if (view.name === 'trip') return <Trip rideId={view.rideId} onNavigate={setView} />
  if (view.name === 'driver-home') return <DriverHome onNavigate={setView} />
  if (view.name === 'driver-trip') return <DriverTrip rideId={view.rideId} onNavigate={setView} />
  return <Home onNavigate={setView} />
}
