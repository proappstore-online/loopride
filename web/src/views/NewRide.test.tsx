import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { geocode, firstMatch, fetchRoute } = vi.hoisted(() => ({ geocode: vi.fn(), firstMatch: vi.fn(), fetchRoute: vi.fn() }))
vi.mock('../lib/maps', () => ({ geocode, firstMatch }))
vi.mock('../lib/routing', () => ({ fetchRoute }))
vi.mock('../lib/app', () => ({ app: { auth: { token: null, onChange: () => () => undefined }, kv: { set: vi.fn(), get: vi.fn() } } }))

import NewRide from './NewRide'
import { listRides } from '../storage'
import { renderWithRouter } from '../../test/router'

function mount(path = '/new') { const wrap = renderWithRouter(<NewRide />, path); render(wrap.ui); return wrap }

describe('NewRide', () => {
  it('requires a pickup and destination before a ride can be requested', async () => {
    mount()
    const request = screen.getByRole('button', { name: /Request RideShare/ })
    expect(request).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('Enter pickup'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('Where are you going?'), 'Airport')
    expect(request).toBeEnabled()
  })

  it('lets a rider select a higher-capacity vehicle', async () => {
    mount()
    await userEvent.click(screen.getByRole('button', { name: /RideShare XL/ }))
    expect(screen.getByRole('button', { name: /Request RideShare XL/ })).toBeInTheDocument()
  })

  it('creates an immediate ride and opens live tracking', async () => {
    firstMatch.mockReset()
    firstMatch.mockResolvedValueOnce({ lat: -33.8, lng: 151.2 }).mockResolvedValueOnce({ lat: -33.85, lng: 151.21 })
    fetchRoute.mockReset()
    fetchRoute.mockResolvedValueOnce({ coordinates: [[151.2, -33.8], [151.21, -33.85]], distanceMeters: 1234, durationSeconds: 240 })
    const wrap = mount()
    await userEvent.type(screen.getByPlaceholderText('Enter pickup'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('Where are you going?'), 'Airport')
    await userEvent.click(screen.getByRole('button', { name: /Request RideShare/ }))
    await waitFor(() => expect(wrap.location()).toMatch(/^\/trip\//))
    expect(listRides()[0]).toMatchObject({ bookingType: 'now', driverName: 'Jordan', vehicle: 'share', etaMinutes: 4, fareCents: 1180 })
  })

  it('offers a recurring routine as a secondary mode', async () => {
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Routine' }))
    expect(screen.getByText('Build a routine')).toBeInTheDocument()
    const mon = screen.getByRole('button', { name: 'Mon' })
    expect(mon).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(mon)
    expect(mon).toHaveAttribute('aria-pressed', 'false')
  })
})
