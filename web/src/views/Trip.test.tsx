import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('./TripMap', () => ({
  default: ({ driver }: { driver: { lat: number; lng: number } | null }) => (
    <div data-testid="trip-map" data-driver={driver ? `${driver.lat},${driver.lng}` : 'none'} />
  ),
}))

import Trip from './Trip'
import { saveRide } from '../storage'
import { publish } from '../lib/channel'
import type { RecurringRide } from '../types'

const ride: RecurringRide = {
  id: 'ride-trip',
  pickup: 'A',
  pickupCoord: { lat: 0, lng: 0 },
  dropoff: 'B',
  dropoffCoord: { lat: 1, lng: 1 },
  days: ['mon'],
  time: '08:00',
  driverName: 'Alex',
  paused: false,
  createdAt: 1,
}

const tick = () => new Promise((r) => setTimeout(r, 30))

describe('Trip', () => {
  it('renders ride summary and shows scheduled by default', () => {
    saveRide(ride)
    render(<Trip rideId="ride-trip" onNavigate={vi.fn()} />)
    expect(screen.getByText('A → B')).toBeInTheDocument()
    expect(screen.getByText(/Alex/)).toBeInTheDocument()
    expect(screen.getByText('Scheduled')).toBeInTheDocument()
    expect(screen.getByText('No live feed')).toBeInTheDocument()
  })

  it('Simulate: driver on way switches status to en-route', async () => {
    saveRide(ride)
    render(<Trip rideId="ride-trip" onNavigate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Simulate: driver on way' }))
    expect(screen.getByText(/Driver en route/)).toBeInTheDocument()
  })

  it('shows Ride not found for unknown id', () => {
    render(<Trip rideId="missing" onNavigate={vi.fn()} />)
    expect(screen.getByText('Ride not found.')).toBeInTheDocument()
  })

  it('reacts to a channel ping with status en-route', async () => {
    saveRide(ride)
    render(<Trip rideId="ride-trip" onNavigate={vi.fn()} />)
    expect(screen.getByText('Scheduled')).toBeInTheDocument()

    await act(async () => {
      publish({
        rideId: 'ride-trip',
        position: { lat: 0.5, lng: 0.5 },
        speedMps: 10,
        accuracyM: 5,
        status: 'en-route',
        at: Date.now(),
      })
      await tick()
    })

    expect(screen.getByText(/Live · /)).toBeInTheDocument()
    expect(screen.getByText('Driver en route')).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.5,0.5')
  })

  it('ignores pings for other ride ids', async () => {
    saveRide(ride)
    render(<Trip rideId="ride-trip" onNavigate={vi.fn()} />)

    await act(async () => {
      publish({
        rideId: 'OTHER',
        position: { lat: 9, lng: 9 },
        speedMps: 10,
        accuracyM: 5,
        status: 'en-route',
        at: Date.now(),
      })
      await tick()
    })

    expect(screen.getByText('Scheduled')).toBeInTheDocument()
    expect(screen.getByText('No live feed')).toBeInTheDocument()
  })

  it('stale ping keeps the dot at last known position (no snap back)', async () => {
    saveRide(ride)
    render(<Trip rideId="ride-trip" onNavigate={vi.fn()} />)

    await act(async () => {
      publish({
        rideId: 'ride-trip',
        position: { lat: 0.7, lng: 0.7 },
        speedMps: 10,
        accuracyM: 5,
        status: 'en-route',
        at: Date.now() - 60_000, // older than REAL_FEED_TIMEOUT_MS (15s)
      })
      await tick()
    })

    expect(screen.getByText(/Last seen/)).toBeInTheDocument()
    expect(screen.queryByText(/Live · /)).not.toBeInTheDocument()
    // Dot stays at the last broadcast position rather than interpolating to pickup.
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.7,0.7')
  })

  it('arrived ping moves status to arrived', async () => {
    saveRide(ride)
    render(<Trip rideId="ride-trip" onNavigate={vi.fn()} />)

    await act(async () => {
      publish({
        rideId: 'ride-trip',
        position: { lat: 1, lng: 1 },
        speedMps: 0,
        accuracyM: 5,
        status: 'arrived',
        at: Date.now(),
      })
      await tick()
    })

    expect(screen.getByText('Driver has arrived')).toBeInTheDocument()
  })
})
