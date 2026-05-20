import type { RecurringRide } from './types'
import { pushRides } from './lib/rideSync'

const KEY = 'loopride.rides.v1'

export function listRides(): RecurringRide[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as RecurringRide[]) : []
  } catch {
    return []
  }
}

export function saveRide(ride: RecurringRide): void {
  const rides = listRides()
  const idx = rides.findIndex((r) => r.id === ride.id)
  if (idx >= 0) rides[idx] = ride
  else rides.unshift(ride)
  localStorage.setItem(KEY, JSON.stringify(rides))
  pushRides(rides)
}

export function deleteRide(id: string): void {
  const rides = listRides().filter((r) => r.id !== id)
  localStorage.setItem(KEY, JSON.stringify(rides))
  pushRides(rides)
}

export function getRide(id: string): RecurringRide | undefined {
  return listRides().find((r) => r.id === id)
}
