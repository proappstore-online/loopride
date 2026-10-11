import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RIDES_KEY } from '../storage'
import type { RecurringRide } from '../types'
import { useRideList } from './useRideList'

const ride: RecurringRide = {
  id: 'other-tab-ride',
  pickup: 'Central Station',
  pickupCoord: { lat: -33.883, lng: 151.206 },
  dropoff: 'Opera House',
  dropoffCoord: { lat: -33.857, lng: 151.215 },
  days: [],
  time: '08:00',
  driverName: 'Jordan',
  paused: false,
  createdAt: 1,
  bookingType: 'now',
}

describe('useRideList', () => {
  it('refreshes when another browser tab changes the rides storage key', () => {
    const { result } = renderHook(() => useRideList())
    expect(result.current).toEqual([])

    localStorage.setItem(RIDES_KEY, JSON.stringify([ride]))
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: RIDES_KEY })))

    expect(result.current).toEqual([ride])
  })
})
