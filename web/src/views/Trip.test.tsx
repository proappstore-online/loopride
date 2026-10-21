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

const { track, route } = vi.hoisted(() => ({
  track: { loc: null as null | { position: { lat: number; lng: number }; accuracyM: number | null; speedMps: number | null; tripStatus: string; ageMs: number; receivedAt: number }, calls: 0 },
  route: { fn: vi.fn() },
}))
vi.mock('../lib/tracking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tracking')>()),
  trackDriver: vi.fn(async (_id: string, o: { signal: AbortSignal; onUpdate: (l: unknown) => void }) => {
    track.calls += 1
    o.onUpdate(track.loc)
    await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve()))
  }),
}))
vi.mock('../lib/routing', () => ({ fetchRoute: (...args: unknown[]) => route.fn(...args) }))

const { tel } = vi.hoisted(() => ({ tel: { reportError: vi.fn() } }))
vi.mock('../lib/telemetry', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/telemetry')>()), reportError: tel.reportError }))

const { receipts } = vi.hoisted(() => ({ receipts: { current: null as Record<string, unknown> | null, load: vi.fn() } }))
vi.mock('../lib/receipts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/receipts')>()), loadReceipt: (...args: unknown[]) => receipts.load(...args) }))

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
import type { RecurringRide } from '../types'
import { renderWithRouter } from '../../test/router'

const legacy: RecurringRide = { id: 'ride-old', pickup: 'A', pickupCoord: { lat: 0, lng: 0 }, dropoff: 'B', dropoffCoord: { lat: 1, lng: 1 }, days: [], time: '08:00', driverName: 'Jordan', paused: false, createdAt: 1, bookingType: 'now', vehicle: 'comfort', fareCents: 1711, etaMinutes: 5, driverPlate: 'RS-482', driverRating: 4.9 }
const live: RecurringRide = { ...legacy, id: 'ride-live', driverName: '', driverPlate: undefined, driverRating: undefined, quoteId: 'q1' }
const mount = (id: string) => render(renderWithRouter(<Trip rideId={id} />).ui)
/** Move the fake clock on until the trip has loaded and the first receipt request has gone out. */
const untilFirstReceiptRequest = async (load: { mock: { calls: unknown[] } }) => {
  for (let i = 0; i < 100 && load.mock.calls.length < 1; i++) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
}

const lifecycle = (extra: Record<string, unknown> = {}) => ({ tripId: 'ride-live:trip', requestId: 'ride-live', phase: 'scheduled', startedAt: null, endedAt: null, outcome: null, cancelledByRole: null, cancelCode: null, cancelFeeCents: 0, feePolicy: null, assignedAt: Date.now(), arrivedAt: null, disputed: false, pickup: null, dropoff: null, ...extra })
const matchedDispatch = { state: 'matched', attempts: 1, offerStatus: 'accepted', driverName: 'Dana', plate: 'RS-9' }

beforeEach(() => {
  tel.reportError.mockReset()
  receipts.current = null
  receipts.load.mockReset()
  receipts.load.mockImplementation(async () => receipts.current)
  track.loc = null
  track.calls = 0
  route.fn.mockReset()
  route.fn.mockResolvedValue({ coordinates: [[1, 1], [0.5, 0.5]], distanceMeters: 2400, durationSeconds: 400 })
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

  const located = (ageMs: number, extra = {}) => ({ position: { lat: 0.5, lng: 0.5 }, accuracyM: 5, speedMps: 10, tripStatus: 'en_route', ageMs, receivedAt: Date.now(), ...extra })

  it('shows a live driver position and a route-based ETA to the pickup', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    track.loc = located(2000)
    mount('ride-live')
    expect(await screen.findByText(/Live · \d+s ago/)).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.5,0.5')
    expect(await screen.findByText('7 min until pickup')).toBeInTheDocument()
    expect(route.fn).toHaveBeenCalledWith({ lat: 0.5, lng: 0.5 }, { lat: 0, lng: 0 }, undefined)
  })

  it('ETA heads to the destination once the trip is in progress', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'in_progress' })
    track.loc = located(2000, { tripStatus: 'arrived' })
    mount('ride-live')
    expect(await screen.findByText('7 min to your destination')).toBeInTheDocument()
    expect(route.fn).toHaveBeenCalledWith({ lat: 0.5, lng: 0.5 }, { lat: 1, lng: 1 }, undefined)
  })

  it('falls back to a labelled straight-line ETA when routing is unavailable', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    track.loc = located(1000)
    route.fn.mockRejectedValue(new Error('down'))
    mount('ride-live')
    expect(await screen.findByText(/About .* until pickup \(approximate\)/)).toBeInTheDocument()
  })

  it('marks a delayed feed and still shows the ETA', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    track.loc = located(40_000)
    mount('ride-live')
    expect(await screen.findByText(/Delayed · \d+s ago/)).toBeInTheDocument()
    expect(await screen.findByText('7 min until pickup')).toBeInTheDocument()
  })

  it('does not derive an ETA from a stale location, and says so', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    track.loc = located(3 * 60_000)
    mount('ride-live')
    expect(await screen.findByText(/Last seen 3 min ago/)).toBeInTheDocument()
    expect(screen.getByText(/ETA paused/)).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('0.5,0.5') // last known position stays on the map
    expect(route.fn).not.toHaveBeenCalled()
  })

  it('shows the driver as offline after five minutes and removes them from the map', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    track.loc = located(6 * 60_000)
    mount('ride-live')
    expect(await screen.findByText('Driver offline')).toBeInTheDocument()
    expect(screen.getByTestId('trip-map').dataset.driver).toBe('none')
    expect(route.fn).not.toHaveBeenCalled()
  })

  it('says it is waiting when the driver has not shared a location yet', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    mount('ride-live')
    expect(await screen.findByText('No live location yet')).toBeInTheDocument()
    expect(screen.getByText(/Waiting for your driver/)).toBeInTheDocument()
  })

  it('does not track before the driver starts driving, once they have arrived, or after the trip ends', async () => {
    dispatchState.current = matchedDispatch
    for (const phase of ['scheduled', 'completed', 'cancelled']) {
      track.calls = 0
      tripState.current = lifecycle({ phase })
      const { unmount } = mount('ride-live')
      await screen.findByText(/accepted|completed|cancelled|Trip completed|Cancelled|You cancelled/i).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 30))
      expect(track.calls, phase).toBe(0)
      unmount()
    }
  })

  it('does not show an ETA once the driver has arrived', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'arrived' })
    track.loc = located(1000, { tripStatus: 'arrived' })
    mount('ride-live')
    await screen.findByText('Dana has arrived')
    expect(screen.queryByRole('status', { name: 'ETA' })).not.toBeInTheDocument()
  })

  it('explains what is shared and when it is deleted', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    mount('ride-live')
    expect(await screen.findByText(/shared only while they are on the way or driving you, and is deleted when the trip ends/)).toBeInTheDocument()
  })

  const statement = (extra = {}) => ({ receiptNo: 'RCT-1', tripId: 'ride-live:trip', requestId: 'ride-live', basis: 'fare', currency: 'USD', quotedCents: 1711, baseCents: null, distanceCents: null, timeCents: null, bookingFeeCents: null, minAdjustCents: null, surgeMilli: null, finalCents: 1711, taxRateBp: 0, taxCents: 0, creditsCents: 0, totalCents: 1711, pickup: 'A', dropoff: 'B', finalizedAt: 1, ...extra })

  it('shows the receipt once the trip is completed', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'completed' })
    receipts.current = statement()
    mount('ride-live')
    expect(await screen.findByRole('region', { name: 'Receipt' })).toBeInTheDocument()
    expect(receipts.load).toHaveBeenCalledWith('ride-live')
  })

  it('shows the cancellation fee receipt after a late cancellation', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'cancelled', outcome: 'rider_cancelled', cancelFeeCents: 500 })
    receipts.current = statement({ basis: 'cancellation_fee', finalCents: 500, totalCents: 500 })
    mount('ride-live')
    expect(await screen.findByText('Cancellation fee', { selector: 'dt' })).toBeInTheDocument()
  })

  it('does not ask for a receipt while the trip is still open', async () => {
    dispatchState.current = matchedDispatch
    tripState.current = lifecycle({ phase: 'en_route' })
    mount('ride-live')
    await screen.findByText('Dana is on the way')
    expect(receipts.load).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Receipt' })).not.toBeInTheDocument()
  })

  describe('observability', () => {
    it('raises an alert when a finished trip has no receipt, after trying twice', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        dispatchState.current = matchedDispatch
        tripState.current = lifecycle({ phase: 'completed' })
        receipts.current = null
        mount('ride-live')
        await untilFirstReceiptRequest(receipts.load)
        expect(receipts.load).toHaveBeenCalledTimes(1)
        expect(tel.reportError).not.toHaveBeenCalled() // one more try first
        await act(async () => { await vi.advanceTimersByTimeAsync(2900) })
        expect(receipts.load).toHaveBeenCalledTimes(1) // the retry waits 3 seconds
        await act(async () => { await vi.advanceTimersByTimeAsync(200) })
        expect(receipts.load).toHaveBeenCalledTimes(2)
        expect(tel.reportError).toHaveBeenCalledWith({ domain: 'payment', code: 'receipt_missing', severity: 'error', tripId: 'ride-live:trip', requestId: 'ride-live' })
      } finally {
        vi.useRealTimers()
      }
    })

    it('stays quiet when the receipt arrives on the second try', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        dispatchState.current = matchedDispatch
        tripState.current = lifecycle({ phase: 'completed' })
        receipts.load.mockResolvedValueOnce(null).mockResolvedValue({ receiptNo: 'RCT-1', tripId: 'ride-live:trip', requestId: 'ride-live', basis: 'fare', currency: 'USD', quotedCents: 1, baseCents: null, distanceCents: null, timeCents: null, bookingFeeCents: null, minAdjustCents: null, surgeMilli: null, finalCents: 1, taxRateBp: 0, taxCents: 0, creditsCents: 0, totalCents: 1, pickup: 'A', dropoff: 'B', finalizedAt: 1 })
        mount('ride-live')
        await untilFirstReceiptRequest(receipts.load)
        await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
        expect(receipts.load).toHaveBeenCalledTimes(2)
        expect(tel.reportError).not.toHaveBeenCalled()
        expect(screen.getByRole('region', { name: 'Receipt' })).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    it('raises a transition error when cancelling a legal trip leaves it open', async () => {
      dispatchState.current = matchedDispatch
      tripState.current = lifecycle({ phase: 'en_route' }) // the server "did nothing"
      mount('ride-live')
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel ride' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Confirm cancellation' }))
      await waitFor(() => expect(tel.reportError).toHaveBeenCalledWith({ domain: 'transition', code: 'step_rejected', severity: 'error', action: 'cancel_ride', tripId: 'ride-live:trip', requestId: 'ride-live', detail: 'expected cancelled, got en_route' }))
    })

    it('does not alert on a cancellation that worked', async () => {
      dispatchState.current = matchedDispatch
      tripState.current = lifecycle({ phase: 'en_route' })
      api.cancelRide.mockImplementationOnce(async () => { tripState.current = lifecycle({ phase: 'cancelled', outcome: 'rider_cancelled' }) })
      mount('ride-live')
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel ride' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Confirm cancellation' }))
      await screen.findByText('You cancelled this ride')
      expect(tel.reportError).not.toHaveBeenCalled()
    })

    it('only warns when a driver no-show report is refused', async () => {
      dispatchState.current = matchedDispatch
      tripState.current = lifecycle({ phase: 'en_route', assignedAt: Date.now() - 16 * 60_000 })
      mount('ride-live')
      await userEvent.click(await screen.findByRole('button', { name: "Driver hasn't arrived" }))
      await waitFor(() => expect(tel.reportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'step_refused', severity: 'warn', action: 'report_driver_no_show' })))
    })
  })
})
