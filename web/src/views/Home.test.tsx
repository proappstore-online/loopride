import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Home from './Home'
import { saveRide } from '../storage'
import type { RecurringRide } from '../types'
import { renderWithRouter } from '../../test/router'

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

function mount() {
  const wrap = renderWithRouter(<Home />)
  render(wrap.ui)
  return wrap
}

describe('Home', () => {
  it('shows empty state when no rides exist', () => {
    mount()
    expect(screen.getByText('No rides yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create your first ride' })).toBeInTheDocument()
  })

  it('+ New navigates to /new', async () => {
    const wrap = mount()
    await userEvent.click(screen.getByRole('button', { name: '+ New' }))
    expect(wrap.location()).toBe('/new')
  })

  it('renders a stored ride with route, time, and driver', () => {
    saveRide(ride())
    mount()
    expect(screen.getByText('Central Station → Sydney Opera House')).toBeInTheDocument()
    expect(screen.getByText('08:00')).toBeInTheDocument()
    expect(screen.getByText(/Alex/)).toBeInTheDocument()
    expect(screen.getByText(/Mon, Wed, Fri/)).toBeInTheDocument()
  })

  it('clicking the ride card navigates to /trip/:id', async () => {
    saveRide(ride())
    const wrap = mount()
    await userEvent.click(screen.getByText('Central Station → Sydney Opera House'))
    expect(wrap.location()).toBe('/trip/ride-1')
  })

  it('pause toggles status text on the card', async () => {
    saveRide(ride())
    mount()
    const card = screen.getByRole('listitem')
    await userEvent.click(within(card).getByRole('button', { name: 'Pause' }))
    expect(within(card).getByText(/paused/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  it('delete removes the ride from the list', async () => {
    saveRide(ride())
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.queryByText('Central Station → Sydney Opera House')).not.toBeInTheDocument()
    expect(screen.getByText('No rides yet')).toBeInTheDocument()
  })
})
