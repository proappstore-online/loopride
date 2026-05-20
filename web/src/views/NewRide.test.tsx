import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { geocode, firstMatch, fetchRoute } = vi.hoisted(() => ({
  geocode: vi.fn(),
  firstMatch: vi.fn(),
  fetchRoute: vi.fn(),
}))
vi.mock('../lib/maps', () => ({ geocode, firstMatch }))
vi.mock('../lib/routing', () => ({ fetchRoute }))
vi.mock('../lib/app', () => ({
  app: {
    auth: { token: null, onChange: () => () => undefined },
    kv: { set: vi.fn(), get: vi.fn() },
  },
}))

import NewRide from './NewRide'
import { listRides } from '../storage'
import { renderWithRouter } from '../../test/router'

function mount() {
  const wrap = renderWithRouter(<NewRide />, '/new')
  render(wrap.ui)
  return wrap
}

describe('NewRide', () => {
  it('save button is disabled until all fields are filled', async () => {
    geocode.mockReset()
    mount()
    expect(screen.getByRole('button', { name: 'Save ride' })).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'School')
    expect(screen.getByRole('button', { name: 'Save ride' })).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'Alex')
    expect(screen.getByRole('button', { name: 'Save ride' })).toBeEnabled()
  })

  it('toggles a day off and back on', async () => {
    mount()
    const mon = screen.getByRole('button', { name: 'Mon' })
    expect(mon).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(mon)
    expect(mon).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(mon)
    expect(mon).toHaveAttribute('aria-pressed', 'true')
  })

  it('geocodes both addresses, fetches route, saves the ride with polyline', async () => {
    firstMatch.mockReset()
    firstMatch
      .mockResolvedValueOnce({ lat: -33.8, lng: 151.2 })
      .mockResolvedValueOnce({ lat: -33.85, lng: 151.21 })
    fetchRoute.mockReset()
    fetchRoute.mockResolvedValueOnce({
      coordinates: [
        [151.2, -33.8],
        [151.205, -33.825],
        [151.21, -33.85],
      ],
      distanceMeters: 1234,
      durationSeconds: 240,
    })

    const wrap = mount()
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'School')
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'Alex')
    await userEvent.click(screen.getByRole('button', { name: 'Save ride' }))

    await waitFor(() => expect(wrap.location()).toBe('/'))
    expect(firstMatch).toHaveBeenCalledTimes(2)
    expect(fetchRoute).toHaveBeenCalledTimes(1)
    const rides = listRides()
    expect(rides).toHaveLength(1)
    expect(rides[0]).toMatchObject({
      pickup: 'Home',
      pickupCoord: { lat: -33.8, lng: 151.2 },
      dropoff: 'School',
      dropoffCoord: { lat: -33.85, lng: 151.21 },
      driverName: 'Alex',
      paused: false,
      routePolyline: [
        [151.2, -33.8],
        [151.205, -33.825],
        [151.21, -33.85],
      ],
    })
  })

  it('saves ride with null coords when geocode returns no results', async () => {
    firstMatch.mockReset()
    firstMatch.mockResolvedValue(null)
    fetchRoute.mockReset()
    const wrap = mount()
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'X')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'Y')
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'A')
    await userEvent.click(screen.getByRole('button', { name: 'Save ride' }))
    await waitFor(() => expect(wrap.location()).toBe('/'))
    expect(listRides()[0]).toMatchObject({ pickupCoord: null, dropoffCoord: null })
    expect(listRides()[0].routePolyline).toBeUndefined()
    expect(fetchRoute).not.toHaveBeenCalled()
  })

  it('saves ride without polyline when fetchRoute fails', async () => {
    firstMatch.mockReset()
    firstMatch.mockResolvedValue({ lat: 1, lng: 2 })
    fetchRoute.mockReset()
    fetchRoute.mockRejectedValueOnce(new Error('OSRM down'))
    const wrap = mount()
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'X')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'Y')
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'A')
    await userEvent.click(screen.getByRole('button', { name: 'Save ride' }))
    await waitFor(() => expect(wrap.location()).toBe('/'))
    expect(listRides()[0].routePolyline).toBeUndefined()
  })

  it('surfaces an error and stays on the form when geocode rejects', async () => {
    firstMatch.mockReset()
    firstMatch.mockRejectedValue(new Error('Nominatim down'))
    const wrap = mount()
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'X')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'Y')
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'A')
    await userEvent.click(screen.getByRole('button', { name: 'Save ride' }))
    await waitFor(() => expect(screen.getByText('Nominatim down')).toBeInTheDocument())
    expect(wrap.location()).toBe('/new')
    expect(listRides()).toHaveLength(0)
  })

  it('Cancel navigates home without saving', async () => {
    const wrap = mount()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(wrap.location()).toBe('/')
    expect(listRides()).toHaveLength(0)
  })
})
