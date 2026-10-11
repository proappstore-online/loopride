import { useEffect, useState } from 'react'
import { listRides, RIDES_KEY } from '../storage'
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
    const onStorage = (event: StorageEvent) => {
      if (event.key === RIDES_KEY) onSync()
    }
    window.addEventListener(EVENTS.ridesChanged, onSync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENTS.ridesChanged, onSync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return rides
}
