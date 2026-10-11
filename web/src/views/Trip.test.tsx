import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

vi.mock('./TripMap', () => ({ default: ({ driver }: { driver: { lat: number; lng: number } | null }) => <div data-testid="trip-map" data-driver={driver ? `${driver.lat},${driver.lng}` : 'none'} /> }))

import Trip from './Trip'
import { saveRide } from '../storage'
import { publish } from '../lib/channel'
import type { RecurringRide } from '../types'
import { renderWithRouter } from '../../test/router'

const ride: RecurringRide = { id: 'ride-trip', pickup: 'A', pickupCoord: { lat: 0, lng: 0 }, dropoff: 'B', dropoffCoord: { lat: 1, lng: 1 }, days: [], time: '08:00', driverName: 'Jordan', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'comfort', fareCents: 1711, etaMinutes: 5, driverPlate: 'RS-482', driverRating: 4.9 }
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('Trip', () => {
  it('shows the assigned driver, tier, estimate and arrival time', () => {
    saveRide(ride)
    render(renderWithRouter(<Trip rideId="ride-trip" />).ui)
    expect(screen.getByText('Jordan')).toBeInTheDocument()
    expect(screen.getByText(/Comfort.*\$17.11/)).toBeInTheDocument()
    expect(screen.getByText('Jordan arrives in 5 min')).toBeInTheDocument()
  })

  it('counts down from the saved ETA instead of the immutable estimate', () => {
    vi.useFakeTimers()
    try {
      saveRide({ ...ride, etaMinutes: 4 })
      render(renderWithRouter(<Trip rideId="ride-trip" />).ui)
      expect(screen.getByText('Jordan arrives in 4 min')).toBeInTheDocument()

      act(() => vi.advanceTimersByTime(3_000))

      expect(screen.getByText('Jordan arrives in 3 min')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores a persisted completed ride after reload', () => {
    saveRide({ ...ride, status: 'completed' })
    render(renderWithRouter(<Trip rideId="ride-trip" />).ui)
    expect(screen.getByText('Trip completed')).toBeInTheDocument()
  })

  it('shows a useful missing-ride state', () => {
    render(renderWithRouter(<Trip rideId="missing" />).ui)
    expect(screen.getByText('Ride not found.')).toBeInTheDocument()
  })

  it('reacts to a live location ping from the driver', async () => {
    saveRide(ride)
    render(renderWithRouter(<Trip rideId="ride-trip" />).ui)
    await act(async () => { publish({ rideId: 'ride-trip', position: { lat: 0.5, lng: 0.5 }, speedMps: 10, accuracyM: 5, status: 'en-route', at: Date.now() }); await tick() })
    expect(screen.getByText(/Live ·/)).toBeInTheDocument()
    expect(screen.getByText('Jordan is on the way')).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.5,0.5')
  })

  it('keeps the last known driver position if a feed becomes stale', async () => {
    saveRide(ride)
    render(renderWithRouter(<Trip rideId="ride-trip" />).ui)
    await act(async () => { publish({ rideId: 'ride-trip', position: { lat: 0.7, lng: 0.7 }, speedMps: 10, accuracyM: 5, status: 'en-route', at: Date.now() - 60_000 }); await tick() })
    expect(screen.getByText(/Last seen/)).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.7,0.7')
  })
})
