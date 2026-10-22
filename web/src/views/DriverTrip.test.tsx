import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('./TripMap', () => ({ default: () => <div data-testid="trip-map" /> }))
vi.mock('../lib/useWakeLock', () => ({ useWakeLock: () => ({ supported: false, active: false, error: null }) }))
vi.mock('../lib/tracking', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/tracking')>()), publishDriverLocation: (...args: unknown[]) => publishLocation(...args) }))

const { current, api, publishLocation, geo } = vi.hoisted(() => ({
  publishLocation: vi.fn(async (..._args: unknown[]) => undefined),
  geo: { watch: vi.fn(), clear: vi.fn() },
  current: { trip: null as Record<string, unknown> | null },
  api: { driverStep: vi.fn(async () => undefined), driverCancel: vi.fn(async () => undefined), reportRiderNoShow: vi.fn(async () => undefined), openDispute: vi.fn(async () => undefined) },
}))
vi.mock('../lib/tripLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tripLifecycle')>()),
  loadDriverTrip: vi.fn(async () => current.trip),
  ...api,
}))

const { consent } = vi.hoisted(() => ({ consent: { granted: true, set: vi.fn(async (_p: string, _g: boolean) => undefined) } }))
vi.mock('../lib/privacy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/privacy')>()
  return {
    ...real,
    loadConsents: async () => (consent.granted ? { trip_tracking: { granted: true, noticeVersion: real.NOTICE_VERSION, grantedAt: 1, withdrawnAt: null } } : {}),
    setLocationConsent: async (p: string, g: boolean) => { consent.granted = g; return consent.set(p, g) },
  }
})

const { earnings, tel } = vi.hoisted(() => ({ earnings: { rows: [] as Record<string, unknown>[] }, tel: { reportError: vi.fn() } }))
vi.mock('../lib/telemetry', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/telemetry')>()), reportError: tel.reportError }))
vi.mock('../lib/receipts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/receipts')>()), loadEarnings: async () => earnings.rows }))

import DriverTrip from './DriverTrip'
import { renderWithRouter } from '../../test/router'
import { expectNoA11yViolations } from '../../test/axe'

const trip = (extra: Record<string, unknown> = {}) => ({ tripId: 'r1:trip', requestId: 'r1', phase: 'scheduled', startedAt: null, endedAt: null, outcome: null, cancelledByRole: null, cancelCode: null, cancelFeeCents: 0, feePolicy: null, assignedAt: 1, arrivedAt: null, disputed: false, pickup: 'Central', dropoff: 'Airport', pickupCoord: { lat: 0, lng: 0 }, dropoffCoord: { lat: 1, lng: 1 }, ...extra })
const mount = () => render(renderWithRouter(<DriverTrip riderId="rider-1" rideId="r1" />, '/driver/trip/rider-1/r1').ui)

beforeEach(() => {
  consent.granted = true
  consent.set.mockClear()
  tel.reportError.mockReset()
  earnings.rows = []
  current.trip = trip()
  Object.values(api).forEach((f) => f.mockClear())
  publishLocation.mockClear()
  publishLocation.mockResolvedValue(undefined)
  geo.watch.mockReset()
  geo.clear.mockReset()
  geo.watch.mockImplementation((ok: (p: unknown) => void) => { ok({ coords: { latitude: -33.87, longitude: 151.21, accuracy: 7, speed: 9 } }); return 1 })
  vi.stubGlobal('navigator', { geolocation: { watchPosition: geo.watch, clearWatch: geo.clear } })
})

describe('DriverTrip', () => {
  it('has no simulation controls', async () => {
    mount()
    await screen.findByText('Central → Airport')
    expect(screen.queryByText(/\(sim\)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/simulated/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Accept & start trip|Step \+10%/ })).not.toBeInTheDocument()
  })

  it.each([
    ['scheduled', 'Start driving to pickup', 'en_route'],
    ['en_route', "I've arrived", 'arrived'],
    ['arrived', 'Start trip', 'start'],
    ['in_progress', 'Complete trip', 'completed'],
  ])('shows only the next legal step in %s', async (phase, label, run) => {
    current.trip = trip({ phase, arrivedAt: Date.now() })
    mount()
    await userEvent.click(await screen.findByRole('button', { name: label }))
    expect(api.driverStep).toHaveBeenCalledWith(run, 'rider-1', 'r1:trip')
    expect(screen.getAllByRole('button').filter((b) => /Start driving|arrived|Start trip|Complete trip/.test(b.textContent ?? ''))).toHaveLength(1)
  })

  it('cannot cancel once the trip has started', async () => {
    current.trip = trip({ phase: 'in_progress' })
    mount()
    await screen.findByText('Trip in progress')
    expect(screen.queryByRole('button', { name: 'Cancel trip' })).not.toBeInTheDocument()
  })

  it('cancels with a reason the driver chose', async () => {
    current.trip = trip({ phase: 'en_route' })
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel trip' }))
    await userEvent.selectOptions(screen.getByLabelText('Why are you cancelling?'), 'vehicle_issue')
    await userEvent.type(screen.getByLabelText('Details (optional)'), 'flat tyre')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
    await waitFor(() => expect(api.driverCancel).toHaveBeenCalledWith('rider-1', 'r1:trip', 'vehicle_issue', 'flat tyre'))
  })

  it('unlocks the rider no-show only after the 5 minute wait, with a countdown before', async () => {
    current.trip = trip({ phase: 'arrived', arrivedAt: Date.now() - 60_000 })
    const early = mount()
    const waiting = await screen.findByRole('button', { name: /Rider no-show in [34]:\d\d/ })
    expect(waiting).toBeDisabled()
    early.unmount()
    current.trip = trip({ phase: 'arrived', arrivedAt: Date.now() - 6 * 60_000 })
    mount()
    await userEvent.click(await screen.findByRole('button', { name: "Rider didn't show" }))
    expect(api.reportRiderNoShow).toHaveBeenCalledWith('rider-1', 'r1:trip')
  })

  it('shows the outcome of a finished trip and lets the driver report a problem once', async () => {
    current.trip = trip({ phase: 'cancelled', outcome: 'rider_cancelled' })
    mount()
    expect(await screen.findByText('The rider cancelled this ride')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Report a problem' }))
    await userEvent.selectOptions(screen.getByLabelText('What went wrong?'), 'cancel_fee')
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.openDispute).toHaveBeenCalledWith('rider-1', 'r1:trip', 'cancel_fee', ''))
  })

  it("shows a clear message for a trip that isn't theirs", async () => {
    current.trip = null
    mount()
    expect(await screen.findByText(/isn't assigned to you/)).toBeInTheDocument()
  })

  describe('earnings', () => {
    it('shows the accrued payout for a completed trip, and says payouts are not enabled', async () => {
      current.trip = trip({ phase: 'completed', outcome: 'completed' })
      earnings.rows = [{ receiptNo: 'RCT-1', tripId: 'r1:trip', basis: 'fare', finalCents: 1500, taxCents: 0, platformFeeCents: 0, payoutCents: 1500, creditsCents: 0, finalizedAt: 1 }]
      mount()
      expect(await screen.findByRole('status', { name: 'Earnings' })).toHaveTextContent('Earned $15.00 for this trip (accrued; payouts are not enabled yet)')
    })

    it('says there are no earnings for a free cancellation', async () => {
      current.trip = trip({ phase: 'cancelled', outcome: 'driver_cancelled' })
      earnings.rows = [{ receiptNo: 'RCT-2', tripId: 'r1:trip', basis: 'none', finalCents: 0, taxCents: 0, platformFeeCents: 0, payoutCents: 0, creditsCents: 0, finalizedAt: 1 }]
      mount()
      expect(await screen.findByText('No earnings for this trip')).toBeInTheDocument()
    })

    it('shows nothing before the trip ends', async () => {
      current.trip = trip({ phase: 'en_route' })
      mount()
      await screen.findByText('Driving to pickup')
      expect(screen.queryByRole('status', { name: 'Earnings' })).not.toBeInTheDocument()
    })
  })

  describe('location consent', () => {
    it('does not read or send the position until the driver has agreed, and says so', async () => {
      consent.granted = false
      current.trip = trip({ phase: 'en_route' })
      mount()
      expect(await screen.findByRole('region', { name: 'Location during a trip' })).toHaveTextContent(/removed after 24 hours at the latest/)
      expect(screen.getByText("Location sharing is off. The rider can't see you.")).toBeInTheDocument()
      expect(geo.watch).not.toHaveBeenCalled()
      expect(publishLocation).not.toHaveBeenCalled()
      // The trip itself still works without sharing.
      expect(screen.getByRole('button', { name: "I've arrived" })).toBeEnabled()
    })

    it('starts sharing once the driver agrees, recording the purpose', async () => {
      consent.granted = false
      current.trip = trip({ phase: 'en_route' })
      mount()
      await userEvent.click(await screen.findByRole('button', { name: 'Allow' }))
      expect(consent.set).toHaveBeenCalledWith('trip_tracking', true)
      await waitFor(() => expect(geo.watch).toHaveBeenCalled())
      await waitFor(() => expect(publishLocation).toHaveBeenCalled())
      expect(await screen.findByText(/Sharing your live location/)).toBeInTheDocument()
    })

    it('stops reading the position when the driver withdraws mid-trip', async () => {
      current.trip = trip({ phase: 'en_route' })
      mount()
      await waitFor(() => expect(geo.watch).toHaveBeenCalled())
      await userEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }))
      expect(consent.set).toHaveBeenCalledWith('trip_tracking', false)
      await waitFor(() => expect(geo.clear).toHaveBeenCalled())
      expect(await screen.findByText("Location sharing is off. The rider can't see you.")).toBeInTheDocument()
    })

    it('does not ask before the driver is driving', async () => {
      consent.granted = false
      current.trip = trip({ phase: 'scheduled' })
      mount()
      await screen.findByText('Central → Airport')
      expect(screen.queryByRole('region', { name: 'Location during a trip' })).not.toBeInTheDocument()
    })
  })

  describe('location sharing', () => {
    it('sends real GPS as authenticated updates while driving to the pickup', async () => {
      current.trip = trip({ phase: 'en_route' })
      mount()
      await waitFor(() => expect(publishLocation).toHaveBeenCalledWith('rider-1', 'r1:trip', { position: { lat: -33.87, lng: 151.21 }, accuracyM: 7, speedMps: 9 }))
      expect(await screen.findByText(/Sharing your live location with the rider until the trip ends/)).toBeInTheDocument()
    })

    it.each(['arrived', 'in_progress'])('keeps sharing while %s', async (phase) => {
      current.trip = trip({ phase })
      mount()
      await waitFor(() => expect(publishLocation).toHaveBeenCalled())
    })

    it.each(['scheduled', 'completed', 'cancelled'])('shares nothing while %s', async (phase) => {
      current.trip = trip({ phase })
      mount()
      await screen.findByText('Central → Airport')
      await new Promise((r) => setTimeout(r, 30))
      expect(geo.watch).not.toHaveBeenCalled()
      expect(publishLocation).not.toHaveBeenCalled()
      expect(screen.queryByText(/Sharing your live location/)).not.toBeInTheDocument()
    })

    it('stops watching the GPS when the screen goes away', async () => {
      current.trip = trip({ phase: 'en_route' })
      const view = mount()
      await waitFor(() => expect(publishLocation).toHaveBeenCalled())
      view.unmount()
      expect(geo.clear).toHaveBeenCalled()
    })

    it('tells the driver when location is blocked, since the rider cannot see them', async () => {
      geo.watch.mockImplementation((_ok: unknown, fail: (e: { message: string }) => void) => { fail({ message: 'User denied Geolocation' }); return 1 })
      current.trip = trip({ phase: 'en_route' })
      mount()
      expect(await screen.findByText(/User denied Geolocation. The rider can't see you/)).toBeInTheDocument()
      expect(publishLocation).not.toHaveBeenCalled()
    })
  })

  describe('observability', () => {
    it('raises a transition error when a legal step leaves the trip where it was', async () => {
      current.trip = trip({ phase: 'scheduled' }) // the server "did nothing": the reload still says scheduled
      mount()
      await userEvent.click(await screen.findByRole('button', { name: 'Start driving to pickup' }))
      await waitFor(() => expect(tel.reportError).toHaveBeenCalled())
      expect(tel.reportError).toHaveBeenCalledWith({ domain: 'transition', code: 'step_rejected', severity: 'error', action: 'advance_trip', tripId: 'r1:trip', requestId: 'r1', detail: 'expected en_route, got scheduled' })
    })

    it('says nothing when the step took effect', async () => {
      current.trip = trip({ phase: 'scheduled' })
      api.driverStep.mockImplementationOnce(async () => { current.trip = trip({ phase: 'en_route' }) })
      mount()
      await userEvent.click(await screen.findByRole('button', { name: 'Start driving to pickup' }))
      await screen.findByText('Driving to pickup')
      expect(tel.reportError).not.toHaveBeenCalledWith(expect.objectContaining({ domain: 'transition' }))
    })

    it('only warns when someone else already ended the trip', async () => {
      current.trip = trip({ phase: 'arrived' })
      api.driverStep.mockImplementationOnce(async () => { current.trip = trip({ phase: 'cancelled', outcome: 'rider_cancelled' }) })
      mount()
      await userEvent.click(await screen.findByRole('button', { name: 'Start trip' }))
      await waitFor(() => expect(tel.reportError).toHaveBeenCalled())
      expect(tel.reportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'step_superseded', severity: 'warn', action: 'start_trip' }))
    })

    it('checks cancellation and the rider no-show the same way', async () => {
      current.trip = trip({ phase: 'en_route' })
      mount()
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel trip' }))
      await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
      await waitFor(() => expect(tel.reportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'step_rejected', action: 'driver_cancel_trip', detail: 'expected cancelled, got en_route' })))
    })

    it('reports location that cannot be read, so tracking alerts have something to count', async () => {
      geo.watch.mockImplementation((_ok: unknown, fail: (e: { message: string }) => void) => { fail({ message: 'User denied Geolocation' }); return 1 })
      current.trip = trip({ phase: 'en_route' })
      mount()
      await waitFor(() => expect(tel.reportError).toHaveBeenCalledWith(expect.objectContaining({ domain: 'tracking', code: 'location_unavailable', severity: 'warn', tripId: 'r1:trip' })))
    })

    it('reports sharing that keeps failing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        publishLocation.mockRejectedValue(new Error('network'))
        // a fix every second, as a phone would deliver them
        geo.watch.mockImplementation((ok: (p: unknown) => void) => { setInterval(() => ok({ coords: { latitude: -33.87, longitude: 151.21, accuracy: 7, speed: 9 } }), 1000); return 1 })
        current.trip = trip({ phase: 'en_route' })
        mount()
        await vi.advanceTimersByTimeAsync(20_000)
        expect(tel.reportError).toHaveBeenCalledWith({ domain: 'tracking', code: 'publish_failing', severity: 'error', tripId: 'r1:trip', requestId: 'r1' })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('safety', () => {
    it.each(['scheduled', 'en_route', 'arrived', 'in_progress'])('offers the driver a Safety button with emergency guidance while the trip is %s', async (phase) => {
      current.trip = trip({ phase })
      mount()
      await userEvent.click(await screen.findByRole('button', { name: 'Safety' }))
      const panel = screen.getByRole('group', { name: 'Safety' })
      expect(panel).toHaveTextContent(/contact your local emergency services now/)
      expect(screen.getByLabelText('What happened with the rider?')).toBeInTheDocument()
    })

    it('is available after the trip for a week only', async () => {
      current.trip = trip({ phase: 'completed', endedAt: Date.now() - 2 * 86_400_000 })
      const first = mount()
      expect(await screen.findByRole('button', { name: 'Safety' })).toBeInTheDocument()
      first.unmount()
      current.trip = trip({ phase: 'completed', endedAt: Date.now() - 9 * 86_400_000 })
      mount()
      await screen.findByRole('button', { name: 'Report a problem' })
      expect(screen.queryByRole('button', { name: 'Safety' })).not.toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it.each(['scheduled', 'en_route', 'arrived', 'in_progress', 'completed'])('has no axe violations in %s and lists the route as text', async (phase) => {
      current.trip = trip({ phase })
      const { container } = mount()
      const details = await screen.findByRole('region', { name: 'Route details' })
      expect(details).toHaveTextContent(/Pickup/)
      expect(details).toHaveTextContent(/Drop-off/)
      await expectNoA11yViolations(container)
    })

    it('announces the status headline politely', async () => {
      current.trip = trip({ phase: 'en_route' })
      mount()
      expect(await screen.findByText('Driving to pickup')).toHaveAttribute('aria-live', 'polite')
    })
  })

})
