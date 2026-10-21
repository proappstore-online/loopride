import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('./TripMap', () => ({ default: ({ driver }: { driver: { lat: number; lng: number } | null }) => <div data-testid="trip-map" data-driver={driver ? `${driver.lat},${driver.lng}` : 'none'} /> }))

const { dispatchState, tripState, api } = vi.hoisted(() => ({
  dispatchState: { current: { state: 'searching', attempts: 0, offerStatus: null, driverName: null, plate: null } as Record<string, unknown> },
  tripState: { current: null as Record<string, unknown> | null },
  api: {
    startDispatch: vi.fn(async () => undefined),
    previewCancellation: vi.fn(async () => ({ feeCents: 0, policy: 'none' })),
    cancelRide: vi.fn(async () => undefined),
    reportDriverNoShow: vi.fn(async () => undefined),
    openDispute: vi.fn(async () => undefined),
  },
}))

vi.mock('../lib/dispatch', () => ({
  runDispatch: vi.fn(async (_id: string, o: { onUpdate: (s: unknown) => void }) => {
    o.onUpdate(dispatchState.current)
    return dispatchState.current.state === 'searching' ? new Promise(() => undefined) : dispatchState.current
  }),
  startDispatch: api.startDispatch,
}))
vi.mock('../lib/tripLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tripLifecycle')>()),
  loadRiderTrip: vi.fn(async () => tripState.current),
  previewCancellation: api.previewCancellation,
  cancelRide: api.cancelRide,
  reportDriverNoShow: api.reportDriverNoShow,
  openDispute: api.openDispute,
  currentUserId: () => 'rider-1',
}))

import Trip from './Trip'
import { saveRide } from '../storage'
import { publish } from '../lib/channel'
import type { RecurringRide } from '../types'
import { renderWithRouter } from '../../test/router'

const legacy: RecurringRide = { id: 'ride-old', pickup: 'A', pickupCoord: { lat: 0, lng: 0 }, dropoff: 'B', dropoffCoord: { lat: 1, lng: 1 }, days: [], time: '08:00', driverName: 'Jordan', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'comfort', fareCents: 1711, etaMinutes: 5, driverPlate: 'RS-482', driverRating: 4.9 }
const live: RecurringRide = { ...legacy, id: 'ride-live', driverName: '', driverPlate: undefined, driverRating: undefined, quoteId: 'q1' }
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const mount = (id: string) => render(renderWithRouter(<Trip rideId={id} />).ui)

const lifecycle = (extra: Record<string, unknown> = {}) => ({ tripId: 'ride-live:trip', requestId: 'ride-live', phase: 'scheduled', startedAt: null, endedAt: null, outcome: null, cancelledByRole: null, cancelCode: null, cancelFeeCents: 0, feePolicy: null, assignedAt: Date.now(), arrivedAt: null, disputed: false, pickup: null, dropoff: null, ...extra })
const matchedDispatch = { state: 'matched', attempts: 1, offerStatus: 'accepted', driverName: 'Dana', plate: 'RS-9' }

beforeEach(() => {
  dispatchState.current = { state: 'searching', attempts: 0, offerStatus: null, driverName: null, plate: null }
  tripState.current = null
  Object.values(api).forEach((f) => f.mockClear())
})

describe('Trip: rides that are not dispatched', () => {
  it('shows a saved on-demand record statically, with no simulated progress controls', () => {
    saveRide(legacy)
    mount('ride-old')
    expect(screen.getByText(/Comfort.*\$17\.11/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Preview driver arrival|Driver arrived|Trip complete/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/arrives in/)).not.toBeInTheDocument()
  })

  it('does not tick an arrival countdown', () => {
    vi.useFakeTimers()
    try {
      saveRide(legacy)
      mount('ride-old')
      act(() => vi.advanceTimersByTime(30_000))
      expect(screen.queryByText(/arrives in/)).not.toBeInTheDocument()
      expect(screen.queryByText('Your driver has arrived')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores a persisted completed ride after reload', () => {
    saveRide({ ...legacy, status: 'completed' })
    mount('ride-old')
    expect(screen.getByText('Trip completed')).toBeInTheDocument()
  })

  it('shows a useful missing-ride state', () => {
    mount('missing')
    expect(screen.getByText('Ride not found.')).toBeInTheDocument()
  })
})

describe('Trip: server-driven rides', () => {
  beforeEach(() => saveRide(live))

  it('shows searching, never a simulated driver, and a cancel option', async () => {
    mount('ride-live')
    expect(await screen.findByText('Finding a nearby driver')).toBeInTheDocument()
    expect(screen.queryByText(/Jordan/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel ride' })).toBeInTheDocument()
  })

  it('offers to search again when no driver was found', async () => {
    dispatchState.current = { state: 'no_driver', attempts: 3, offerStatus: null, driverName: null, plate: null }
    mount('ride-live')
    await userEvent.click(await screen.findByRole('button', { name: 'Search again' }))
    expect(api.startDispatch).toHaveBeenCalledWith('ride-live')
  })

  it.each([
    ['scheduled', 'Dana accepted and is getting ready'],
    ['en_route', 'Dana is on the way'],
    ['arrived', 'Dana has arrived'],
    ['in_progress', 'On your way'],
    ['completed', 'Trip completed'],
  ])('reflects the server phase %s', async (phase, text) => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase })
    mount('ride-live')
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.getByText('RS-9')).toBeInTheDocument()
  })

  it('offers cancel only before the trip starts', async () => {
    dispatchState.current = matchedDispatch
    for (const [phase, cancellable] of [['en_route', true], ['arrived', true], ['in_progress', false], ['completed', false]] as const) {
      tripState.current = lifecycle({ phase })
      const { unmount } = mount('ride-live')
      await screen.findByText(/Dana|On your way|Trip completed/)
      await waitFor(() => expect(Boolean(screen.queryByRole('button', { name: 'Cancel ride' }))).toBe(cancellable))
      unmount()
    }
  })

  it('shows the fee before cancelling, then cancels with the chosen reason', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    api.previewCancellation.mockResolvedValueOnce({ feeCents: 500, policy: 'late_cancel' })
    mount('ride-live')
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel ride' }))
    expect(await screen.findByText('A $5.00 cancellation fee applies.')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Why are you cancelling?'), 'wait_too_long')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
    await waitFor(() => expect(api.cancelRide).toHaveBeenCalledWith('ride-live', 'wait_too_long'))
  })

  it('says cancelling is free when it is', async () => {
    mount('ride-live')
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel ride' }))
    expect(await screen.findByText('Free to cancel.')).toBeInTheDocument()
  })

  it('shows who cancelled and what it cost', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'cancelled', outcome: 'rider_no_show', cancelFeeCents: 800 })
    mount('ride-live')
    expect(await screen.findByText('Cancelled: no one met the driver at pickup')).toBeInTheDocument()
    expect(screen.getByText('Cancellation fee: $8.00')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel ride' })).not.toBeInTheDocument()
  })

  it('lets the rider report a driver who never came, only after the wait', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route', assignedAt: Date.now() - 14 * 60_000 })
    const early = mount('ride-live')
    await screen.findByText('Dana is on the way')
    expect(screen.queryByRole('button', { name: "Driver hasn't arrived" })).not.toBeInTheDocument()
    early.unmount()
    tripState.current = lifecycle({ phase: 'en_route', assignedAt: Date.now() - 16 * 60_000 })
    mount('ride-live')
    await userEvent.click(await screen.findByRole('button', { name: "Driver hasn't arrived" }))
    expect(api.reportDriverNoShow).toHaveBeenCalledWith('ride-live')
  })

  it('lets the rider report a problem with a finished trip, once', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'completed' })
    mount('ride-live')
    await userEvent.click(await screen.findByRole('button', { name: 'Report a problem' }))
    await userEvent.selectOptions(screen.getByLabelText('What went wrong?'), 'overcharged')
    await userEvent.type(screen.getByLabelText('Details (optional)'), 'extra fee')
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.openDispute).toHaveBeenCalledWith('rider-1', 'ride-live:trip', 'overcharged', 'extra fee'))
  })

  it('does not offer a report again once disputed', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'completed', disputed: true })
    mount('ride-live')
    expect(await screen.findByText(/Problem reported/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Report a problem' })).not.toBeInTheDocument()
  })

  it('follows a real live location ping from the driver, and keeps the last position when it goes stale', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    mount('ride-live')
    await screen.findByText('Dana is on the way')
    await act(async () => { publish({ rideId: 'ride-live', position: { lat: 0.5, lng: 0.5 }, speedMps: 10, accuracyM: 5, status: 'en-route', at: Date.now() }); await tick() })
    expect(screen.getByText(/Live ·/)).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.5,0.5')
    await act(async () => { publish({ rideId: 'ride-live', position: { lat: 0.7, lng: 0.7 }, speedMps: 10, accuracyM: 5, status: 'en-route', at: Date.now() - 60_000 }); await tick() })
    expect(screen.getByText(/Last seen/)).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.7,0.7')
  })
})
