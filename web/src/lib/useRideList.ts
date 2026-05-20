import { useEffect, useState } from 'react'
import { listRides } from '../storage'
import type { RecurringRide } from '../types'
import { EVENTS } from './constants'

/**
 * Subscribed view of the local ride list. Refreshes on the `loopride:rides-synced`
 * event fired by rideSync after a cross-device adoption.
 */
export function useRideList(): RecurringRide[] {
  const [rides, setRides] = useState<RecurringRide[]>(() => listRides())

  useEffect(() => {
    const onSync = () => setRides(listRides())
    window.addEventListener(EVENTS.ridesChanged, onSync)
    return () => window.removeEventListener(EVENTS.ridesChanged, onSync)
  }, [])

  return rides
}
