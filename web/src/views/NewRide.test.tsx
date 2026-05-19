import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { geocode } = vi.hoisted(() => ({ geocode: vi.fn() }))
vi.mock('../lib/app', () => ({ app: { maps: { geocode } } }))

import NewRide from './NewRide'
import { listRides } from '../storage'

describe('NewRide', () => {
  it('save button is disabled until all fields are filled', async () => {
    geocode.mockReset()
    render(<NewRide onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Save ride' })).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'School')
    expect(screen.getByRole('button', { name: 'Save ride' })).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'Alex')
    expect(screen.getByRole('button', { name: 'Save ride' })).toBeEnabled()
  })

  it('toggles a day off and back on', async () => {
    render(<NewRide onNavigate={vi.fn()} />)
    const mon = screen.getByRole('button', { name: 'Mon' })
    expect(mon).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(mon)
    expect(mon).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(mon)
    expect(mon).toHaveAttribute('aria-pressed', 'true')
  })

  it('geocodes both addresses, saves the ride, and navigates home', async () => {
    geocode.mockReset()
    geocode
      .mockResolvedValueOnce([{ lat: -33.8, lng: 151.2, displayName: 'Home', address: {}, type: 'house', importance: 0.5 }])
      .mockResolvedValueOnce([{ lat: -33.85, lng: 151.21, displayName: 'School', address: {}, type: 'school', importance: 0.5 }])

    const onNavigate = vi.fn()
    render(<NewRide onNavigate={onNavigate} />)
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'School')
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'Alex')
    await userEvent.click(screen.getByRole('button', { name: 'Save ride' }))

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith({ name: 'home' }))
    expect(geocode).toHaveBeenCalledTimes(2)
    const rides = listRides()
    expect(rides).toHaveLength(1)
    expect(rides[0]).toMatchObject({
      pickup: 'Home',
      pickupCoord: { lat: -33.8, lng: 151.2 },
      dropoff: 'School',
      dropoffCoord: { lat: -33.85, lng: 151.21 },
      driverName: 'Alex',
      paused: false,
    })
  })

  it('saves ride with null coords when geocode returns no results', async () => {
    geocode.mockReset()
    geocode.mockResolvedValue([])
    const onNavigate = vi.fn()
    render(<NewRide onNavigate={onNavigate} />)
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'X')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'Y')
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'A')
    await userEvent.click(screen.getByRole('button', { name: 'Save ride' }))
    await waitFor(() => expect(onNavigate).toHaveBeenCalled())
    expect(listRides()[0]).toMatchObject({ pickupCoord: null, dropoffCoord: null })
  })

  it('surfaces an error and stays on the form when geocode rejects', async () => {
    geocode.mockReset()
    geocode.mockRejectedValue(new Error('Nominatim down'))
    const onNavigate = vi.fn()
    render(<NewRide onNavigate={onNavigate} />)
    await userEvent.type(screen.getByPlaceholderText('123 Home Street'), 'X')
    await userEvent.type(screen.getByPlaceholderText('456 School Road'), 'Y')
    await userEvent.type(screen.getByPlaceholderText('e.g. Alex Smith'), 'A')
    await userEvent.click(screen.getByRole('button', { name: 'Save ride' }))
    await waitFor(() => expect(screen.getByText('Nominatim down')).toBeInTheDocument())
    expect(onNavigate).not.toHaveBeenCalled()
    expect(listRides()).toHaveLength(0)
  })

  it('Cancel navigates home without saving', async () => {
    const onNavigate = vi.fn()
    render(<NewRide onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onNavigate).toHaveBeenCalledWith({ name: 'home' })
    expect(listRides()).toHaveLength(0)
  })
})
