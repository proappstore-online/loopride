import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Home from './Home'
import { saveRide } from '../storage'
import type { RecurringRide } from '../types'

const ride = (overrides: Partial<RecurringRide> = {}): RecurringRide => ({
  id: 'ride-1',
  pickup: 'Central Station',
  pickupCoord: { lat: -33.8688, lng: 151.2093 },
  dropoff: 'Sydney Opera House',
  dropoffCoord: { lat: -33.857, lng: 151.215 },
  days: ['mon', 'wed', 'fri'],
  time: '08:00',
  driverName: 'Alex',
  paused: false,
  createdAt: 1,
  ...overrides,
})

describe('Home', () => {
  it('shows empty state when no rides exist', () => {
    render(<Home onNavigate={vi.fn()} />)
    expect(screen.getByText('No rides yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create your first ride' })).toBeInTheDocument()
  })

  it('+ New navigates to the new-ride form', async () => {
    const onNavigate = vi.fn()
    render(<Home onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('button', { name: '+ New' }))
    expect(onNavigate).toHaveBeenCalledWith({ name: 'new' })
  })

  it('renders a stored ride with route, time, and driver', () => {
    saveRide(ride())
    render(<Home onNavigate={vi.fn()} />)
    expect(screen.getByText('Central Station → Sydney Opera House')).toBeInTheDocument()
    expect(screen.getByText('08:00')).toBeInTheDocument()
    expect(screen.getByText(/Alex/)).toBeInTheDocument()
    expect(screen.getByText(/Mon, Wed, Fri/)).toBeInTheDocument()
  })

  it('clicking the ride card navigates to trip', async () => {
    saveRide(ride())
    const onNavigate = vi.fn()
    render(<Home onNavigate={onNavigate} />)
    await userEvent.click(screen.getByText('Central Station → Sydney Opera House'))
    expect(onNavigate).toHaveBeenCalledWith({ name: 'trip', rideId: 'ride-1' })
  })

  it('pause toggles status text on the card', async () => {
    saveRide(ride())
    render(<Home onNavigate={vi.fn()} />)
    const card = screen.getByRole('listitem')
    await userEvent.click(within(card).getByRole('button', { name: 'Pause' }))
    expect(within(card).getByText(/paused/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  it('delete removes the ride from the list', async () => {
    saveRide(ride())
    render(<Home onNavigate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.queryByText('Central Station → Sydney Opera House')).not.toBeInTheDocument()
    expect(screen.getByText('No rides yet')).toBeInTheDocument()
  })
})
