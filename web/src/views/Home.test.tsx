import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Home from './Home'
import { listRides, saveRide } from '../storage'
import type { RecurringRide } from '../types'
import { renderWithRouter } from '../../test/router'
import { expectNoA11yViolations } from '../../test/axe'

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

  it('sends a matched ride to its trip page to cancel (reason and fee first) instead of deleting it', async () => {
    saveRide({ ...ride, id: 'live-1', quoteId: 'q1' })
    const wrap = mount()
    await userEvent.click(screen.getByRole('button', { name: 'Manage ride' }))
    expect(wrap.location()).toBe('/trip/live-1')
    expect(listRides().map((r) => r.id)).toContain('live-1')
  })

  it('has no accessibility violations, with and without rides, and hides decorative glyphs', async () => {
    const empty = render(renderWithRouter(<Home />).ui)
    await expectNoA11yViolations(empty.container)
    empty.unmount()
    saveRide(ride)
    const { container } = mount()
    await expectNoA11yViolations(container)
    expect(screen.getByRole('button', { name: /Where to/ })).toHaveAccessibleName('Where to? Request a ride now')
  })

})
