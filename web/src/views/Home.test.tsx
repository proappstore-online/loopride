import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Home from './Home'
import { saveRide } from '../storage'
import type { RecurringRide } from '../types'
import { renderWithRouter } from '../../test/router'

const ride: RecurringRide = { id: 'ride-1', pickup: 'Central Station', pickupCoord: null, dropoff: 'Opera House', dropoffCoord: null, days: [], time: '08:00', driverName: 'Jordan', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'share', fareCents: 1280 }

function mount() { const wrap = renderWithRouter(<Home />); render(wrap.ui); return wrap }

describe('Home', () => {
  it('puts requesting a ride first when no rides exist', () => {
    mount()
    expect(screen.getByRole('button', { name: /Where to/ })).toBeInTheDocument()
    expect(screen.getByText('Ready when you are')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reserve later/ })).toBeInTheDocument()
  })

  it('opens the request flow', async () => {
    const wrap = mount()
    await userEvent.click(screen.getByRole('button', { name: /Where to/ }))
    expect(wrap.location()).toBe('/new')
  })

  it('shows active ride, driver and estimate', () => {
    saveRide(ride)
    mount()
    expect(screen.getByText('Opera House')).toBeInTheDocument()
    expect(screen.getByText('Driver: Jordan')).toBeInTheDocument()
    expect(screen.getByText('$12.80')).toBeInTheDocument()
  })

  it('opens and cancels an active ride', async () => {
    saveRide(ride)
    const wrap = mount()
    await userEvent.click(screen.getByText('Opera House'))
    expect(wrap.location()).toBe('/trip/ride-1')
  })
})
