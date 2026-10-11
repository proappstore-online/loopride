import { useEffect, useState } from 'react'
import { listRides } from '../storage'
import type { RecurringRide } from '../types'
import { EVENTS, STORAGE_KEYS } from './constants'

/**
 * Subscribed view of the local ride list. Refreshes on the same-tab
 * `loopride:rides-changed` event (local writes + remote sync) and on the
 * browser `storage` event when another tab writes or clears the ride list.
 */
export function useRideList(): RecurringRide[] {
  const [rides, setRides] = useState<RecurringRide[]>(() => listRides())

  useEffect(() => {
    const onChange = () => setRides(listRides())
    // key === null means another tab called localStorage.clear().
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.rides || e.key === null) onChange()
    }
    window.addEventListener(EVENTS.ridesChanged, onChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENTS.ridesChanged, onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return rides
}
