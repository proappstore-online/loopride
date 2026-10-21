import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { geocode, firstMatch, fetchRoute } = vi.hoisted(() => ({ geocode: vi.fn(), firstMatch: vi.fn(), fetchRoute: vi.fn() }))
vi.mock('../lib/maps', () => ({ geocode, firstMatch }))
vi.mock('../lib/routing', () => ({ fetchRoute }))
const { authState, actions, signIn } = vi.hoisted(() => ({ authState: { user: null as { id: string } | null }, actions: { call: vi.fn() }, signIn: vi.fn() }))
vi.mock('../lib/app', () => ({ app: { auth: { token: null, onChange: () => () => undefined, signIn }, kv: { set: vi.fn(), get: vi.fn() }, actions } }))
vi.mock('../lib/useAuth', () => ({ useAuth: () => ({ user: authState.user, loading: false, signOut: vi.fn() }) }))

import NewRide from './NewRide'
import { listRides } from '../storage'
import { renderWithRouter } from '../../test/router'

function mount(path = '/new') { const wrap = renderWithRouter(<NewRide />, path); render(wrap.ui); return wrap }

beforeEach(() => {
  authState.user = null
  actions.call.mockReset()
  signIn.mockReset()
})

describe('NewRide (signed out)', () => {
  it('asks the rider to sign in to ride now, with no preview, estimate or simulated driver', async () => {
    mount()
    expect(screen.getByRole('note')).toHaveTextContent(/Sign in to ride now/)
    expect(screen.queryByRole('button', { name: 'Get quotes' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Request/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Estimate shown before booking/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))
    expect(signIn).toHaveBeenCalledWith('google')
    expect(listRides()).toEqual([])
  })

  it('still lets a signed-out rider reserve a ride for later, with no driver attached', async () => {
    firstMatch.mockReset()
    firstMatch.mockResolvedValueOnce({ lat: -33.8, lng: 151.2 }).mockResolvedValueOnce({ lat: -33.85, lng: 151.21 })
    fetchRoute.mockReset()
    fetchRoute.mockResolvedValueOnce({ coordinates: [[151.2, -33.8], [151.21, -33.85]], distanceMeters: 1234, durationSeconds: 240 })
    const wrap = mount()
    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    await userEvent.type(screen.getByPlaceholderText('Enter pickup'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('Where are you going?'), 'Airport')
    await userEvent.click(screen.getByRole('button', { name: /RideShare XL/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Reserve ride' }))
    await waitFor(() => expect(wrap.location()).toBe('/'))
    expect(listRides()[0]).toMatchObject({ bookingType: 'scheduled', driverName: '', vehicle: 'xl', pickup: 'Home' })
    expect(listRides()[0].driverPlate).toBeUndefined()
  })

  it('requires a pickup and destination before a reservation can be saved', async () => {
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    const reserve = screen.getByRole('button', { name: 'Reserve ride' })
    expect(reserve).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('Enter pickup'), 'Home')
    await userEvent.type(screen.getByPlaceholderText('Where are you going?'), 'Airport')
    expect(reserve).toBeEnabled()
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

const PICK = { lat: -33.8688, lng: 151.2093 }
const DROP = { lat: -33.8238, lng: 151.2093 }

interface Stored { id: string; vehicle_class: string; total_cents: number; nearby_drivers: number; expires_at: number; surge_milli?: number; min_adjust_cents?: number }

/** A fake server: create_quote stores per-tier quotes, accept_quote consults `outcome`. */
function serve(opts: { nearby?: Record<string, number>; outcome?: 'accepted' | 'expired' | 'superseded'; expiresIn?: number; surge?: number } = {}) {
  const stored: Stored[] = []
  const totals: Record<string, number> = { share: 1150, comfort: 1530, xl: 1950 }
  let accepted: { quote_id: string; ride_id: string } | null = null
  actions.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
    if (name === 'create_quote') {
      const cls = params.vehicle_class as string
      stored.push({ id: params.quote_id as string, vehicle_class: cls, total_cents: totals[cls], nearby_drivers: opts.nearby?.[cls] ?? 2, expires_at: Date.now() + (opts.expiresIn ?? 300_000), surge_milli: opts.surge ?? 1000 })
      return undefined
    }
    if (name === 'list_pending_quotes')
      return stored.map((q) => ({ id: q.id, vehicle_class: q.vehicle_class, distance_m: 5000, duration_s: 600, base_cents: 200, distance_cents: 550, time_cents: 250, booking_fee_cents: 150, min_adjust_cents: 0, surge_milli: q.surge_milli, total_cents: q.total_cents, nearby_drivers: q.nearby_drivers, expires_at: q.expires_at }))
    if (name === 'accept_quote') {
      if ((opts.outcome ?? 'accepted') === 'accepted') accepted = { quote_id: params.quote_id as string, ride_id: params.ride_id as string }
      return undefined
    }
    if (name === 'get_quote') return [{ status: accepted ? 'accepted' : opts.outcome, ride_id: accepted?.ride_id ?? null }]
    return undefined
  })
}

async function fillAndQuote() {
  firstMatch.mockReset()
  firstMatch.mockResolvedValueOnce(PICK).mockResolvedValueOnce(DROP)
  fetchRoute.mockReset()
  fetchRoute.mockResolvedValue({ coordinates: [[151.2, -33.8], [151.21, -33.85]], distanceMeters: 5000, durationSeconds: 600 })
  const wrap = mount()
  await userEvent.type(screen.getByPlaceholderText('Enter pickup'), 'Central')
  await userEvent.type(screen.getByPlaceholderText('Where are you going?'), 'North Sydney')
  await userEvent.click(screen.getByRole('button', { name: 'Get quotes' }))
  return wrap
}

describe('NewRide (signed in: live quotes)', () => {
  beforeEach(() => {
    authState.user = { id: 'rider-1' }
  })

  it('geocodes, routes and shows the route distance and duration', async () => {
    serve()
    await fillAndQuote()
    expect(await screen.findByTestId('route-summary')).toHaveTextContent('5.0 km · about 10 min')
    expect(fetchRoute).toHaveBeenCalledWith(PICK, DROP)
    const create = actions.call.mock.calls.filter((c) => c[0] === 'create_quote')
    expect(create).toHaveLength(3)
    expect(create[0][1]).toMatchObject({ pickup_lat: PICK.lat, dropoff_lng: DROP.lng, distance_m: 5000, duration_s: 600 })
    expect(create.map((c) => c[1].vehicle_class).sort()).toEqual(['comfort', 'share', 'xl'])
  })

  it('shows eligibility, the fare breakdown and expiry for each tier before requesting', async () => {
    serve({ nearby: { share: 3, comfort: 0, xl: 1 }, surge: 1500 })
    await fillAndQuote()
    expect(await screen.findByText('3 drivers nearby')).toBeInTheDocument()
    expect(screen.getByText('1 driver nearby')).toBeInTheDocument()
    expect(screen.getByText('No drivers nearby for this option')).toBeInTheDocument()
    expect(screen.getAllByText('Base fare')).toHaveLength(3)
    expect(screen.getAllByText('Booking fee')).toHaveLength(3)
    expect(screen.getAllByText('High demand')).toHaveLength(3)
    expect(screen.getAllByText('1.5×')).toHaveLength(3)
    expect(screen.getAllByText(/Price held for [45]:\d\d/)).toHaveLength(3)
    expect(screen.getByRole('radio', { name: 'Comfort $15.30' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'RideShare $11.50' })).toBeEnabled()
  })

  it('requests the selected tier: the server creates the ride and the app opens the trip', async () => {
    serve()
    const wrap = await fillAndQuote()
    await userEvent.click(await screen.findByRole('radio', { name: 'RideShare XL $19.50' }))
    await userEvent.click(screen.getByRole('button', { name: /Request RideShare XL · \$19\.50/ }))
    await waitFor(() => expect(wrap.location()).toMatch(/^\/trip\//))
    const accept = actions.call.mock.calls.find((c) => c[0] === 'accept_quote')![1]
    expect(accept).toMatchObject({ pickup_lat: PICK.lat, dropoff_lat: DROP.lat, distance_m: 5000 })
    expect(JSON.parse(accept.client_record)).toMatchObject({ vehicle: 'xl', fareCents: 1950, bookingType: 'now' })
    const [ride] = listRides()
    expect(ride).toMatchObject({ id: accept.ride_id, vehicle: 'xl', fareCents: 1950, driverName: '', quoteId: accept.quote_id })
    expect(wrap.location()).toBe(`/trip/${ride.id}`)
  })

  it.each([
    ['expired', /quote expired/],
    ['superseded', /route or local demand changed/],
  ] as const)('shows an error and lets the rider re-quote when the server says %s', async (outcome, message) => {
    serve({ outcome })
    const wrap = await fillAndQuote()
    await userEvent.click(await screen.findByRole('button', { name: /Request RideShare · \$11\.50/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(listRides()).toEqual([])
    expect(wrap.location()).toBe('/new')
    serve()
    firstMatch.mockResolvedValueOnce(PICK).mockResolvedValueOnce(DROP)
    await userEvent.click(screen.getByRole('button', { name: /Get quotes|Refresh quotes/ }))
    expect(await screen.findByRole('button', { name: /Request RideShare/ })).toBeEnabled()
  })

  it('disables an expired quote locally and asks for a refresh', async () => {
    serve({ expiresIn: 1200 })
    await fillAndQuote()
    expect(await screen.findByRole('radio', { name: 'RideShare $11.50' })).toBeEnabled()
    await waitFor(() => expect(screen.getAllByText('Quote expired')).toHaveLength(3), { timeout: 3000 })
    expect(screen.getByRole('button', { name: /Request RideShare/ })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/quotes expired/i)
  })

  it('cannot request when no driver is eligible for any tier', async () => {
    serve({ nearby: { share: 0, comfort: 0, xl: 0 } })
    await fillAndQuote()
    expect(await screen.findByRole('alert')).toHaveTextContent(/No drivers are available nearby/)
    expect(screen.getByRole('button', { name: /Request|Choose a ride/ })).toBeDisabled()
  })

  it('discards the quotes when the destination changes', async () => {
    serve()
    await fillAndQuote()
    await screen.findByRole('radio', { name: 'RideShare $11.50' })
    await userEvent.type(screen.getByPlaceholderText('Where are you going?'), ' Station')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-summary')).not.toBeInTheDocument()
  })

  it('reports an address that cannot be found', async () => {
    serve()
    firstMatch.mockReset()
    firstMatch.mockResolvedValue(null)
    mount()
    await userEvent.type(screen.getByPlaceholderText('Enter pickup'), 'zzz')
    await userEvent.type(screen.getByPlaceholderText('Where are you going?'), 'qqq')
    await userEvent.click(screen.getByRole('button', { name: 'Get quotes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't find one of those addresses/)
    expect(actions.call).not.toHaveBeenCalled()
  })

  it('never falls back to the simulated driver', async () => {
    serve()
    await fillAndQuote()
    await screen.findByRole('radio', { name: 'RideShare $11.50' })
    expect(screen.queryByText(/Estimate shown before booking/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Request RideShare · \$11\.80$/ })).not.toBeInTheDocument()
  })
})
