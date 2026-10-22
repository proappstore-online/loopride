import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { renderWithRouter } from '../../test/router'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe'

const { actions, tel } = vi.hoisted(() => ({ actions: { call: vi.fn() }, tel: { reportError: vi.fn() } }))
vi.mock('../lib/telemetry', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/telemetry')>()), reportError: tel.reportError }))
vi.mock('../lib/app', () => ({ app: { actions } }))

import DriverOffers from './DriverOffers'

const offer = (status: string, extra = {}) => ({ rider_id: 'u', request_id: 'r1', status, distance_km2: 4, expires_at: Date.now() + 20_000, pickup_label: 'Central', dropoff_label: 'Airport', vehicle_class: null, fare_cents: 1500, ...extra })

beforeEach(() => {
  actions.call.mockReset()
  tel.reportError.mockReset()
})

describe('DriverOffers', () => {
  it('renders nothing without an offer', async () => {
    actions.call.mockResolvedValue([])
    const { container } = render(renderWithRouter(<DriverOffers />).ui)
    await waitFor(() => expect(actions.call).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the offer and declines it', async () => {
    actions.call.mockImplementation(async (name: string) => (name === 'list_my_offers' ? [offer('offered')] : undefined))
    render(renderWithRouter(<DriverOffers />).ui)
    expect(await screen.findByText('Central → Airport')).toBeInTheDocument()
    expect(screen.getByText(/2\.0 km away · \$15\.00/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('decline_offer', { rider_id: 'u', request_id: 'r1' }))
  })

  it('accepts and then shows the assignment', async () => {
    let accepted = false
    actions.call.mockImplementation(async (name: string) => {
      if (name === 'accept_offer') accepted = true
      return name === 'list_my_offers' ? [offer(accepted ? 'accepted' : 'offered')] : undefined
    })
    render(renderWithRouter(<DriverOffers />).ui)
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText(/Assigned to you/)).toBeInTheDocument()
  })

  it('opens the assigned trip on the driver trip page', async () => {
    actions.call.mockResolvedValue([offer('accepted')])
    const wrap = renderWithRouter(<DriverOffers />)
    render(wrap.ui)
    await userEvent.click(await screen.findByRole('button', { name: 'Open trip' }))
    expect(wrap.location()).toBe('/driver/trip/u/r1')
  })

  it('hides offers that have expired', async () => {
    actions.call.mockResolvedValue([offer('offered', { expires_at: Date.now() - 1000 })])
    const { container } = render(renderWithRouter(<DriverOffers />).ui)
    await waitFor(() => expect(actions.call).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('records a lost race as a warning, not an error', async () => {
    actions.call.mockImplementation(async (name: string) => (name === 'list_my_offers' ? [offer('offered')] : undefined)) // accept does nothing: the offer is still only "offered"
    render(renderWithRouter(<DriverOffers />).ui)
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(tel.reportError).toHaveBeenCalledWith({ domain: 'transition', code: 'offer_lost', severity: 'warn', action: 'accept_offer', requestId: 'r1' }))
  })

  it('does not report an accept that worked', async () => {
    let accepted = false
    actions.call.mockImplementation(async (name: string) => {
      if (name === 'accept_offer') accepted = true
      return name === 'list_my_offers' ? [offer(accepted ? 'accepted' : 'offered')] : undefined
    })
    render(renderWithRouter(<DriverOffers />).ui)
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await screen.findByText(/Assigned to you/)
    expect(tel.reportError).not.toHaveBeenCalled()
  })

  it('has no accessibility violations for an offer and for an assigned trip', async () => {
    actions.call.mockResolvedValue([offer('offered')])
    const first = render(renderWithRouter(<DriverOffers />).ui)
    await screen.findByRole('button', { name: 'Accept' })
    await expectNoA11yViolations(first.container)
    first.unmount()
    actions.call.mockResolvedValue([offer('accepted')])
    const second = render(renderWithRouter(<DriverOffers />).ui)
    await screen.findByRole('button', { name: 'Open trip' })
    await expectNoA11yViolations(second.container)
  })

  it('lets a driver accept or decline from the keyboard', async () => {
    actions.call.mockResolvedValue([offer('offered')])
    render(renderWithRouter(<DriverOffers />).ui)
    const accept = await screen.findByRole('button', { name: 'Accept' })
    accept.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('accept_offer', expect.anything()))
  })

})
