import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { authState, actions } = vi.hoisted(() => ({ authState: { user: null as { id: string } | null }, actions: { call: vi.fn() } }))
vi.mock('../lib/app', () => ({ app: { actions, auth: { signIn: vi.fn() }, roles: { check: vi.fn() } } }))
vi.mock('../lib/useAuth', () => ({ useAuth: () => ({ user: authState.user, loading: false, signOut: vi.fn() }) }))

import DriverOnboarding from './DriverOnboarding'
import { NOTICE_VERSION } from '../lib/privacy'
import { renderWithRouter } from '../../test/router'

const mount = () => render(renderWithRouter(<DriverOnboarding />, '/driver/onboarding').ui)

const row = (status: string, extra = {}) => ({ status, full_name: 'Dana', phone: '1', licence_number: 'L1', licence_region: 'NSW', licence_expires: '2030-01-01', eligibility_confirmed: 1, status_reason: null, ...extra })
const vehicleRow = (status: string, extra = {}) => ({ id: 'v1', plate: 'RS-1', make: 'Toyota', model: 'Camry', year: null, colour: null, seats: null, vehicle_class: null, status, status_reason: null, ...extra })

const consentRow = (granted: boolean, noticeVersion = NOTICE_VERSION) => ({ purpose: 'dispatch_availability', granted: granted ? 1 : 0, notice_version: noticeVersion, granted_at: 1, withdrawn_at: null })

function serve(application: unknown[], vehicles: unknown[], availability: unknown[] = [], consents: unknown[] = [consentRow(true)]) {
  actions.call.mockImplementation(async (name: string) => {
    if (name === 'get_my_location_consents') return consents
    if (name === 'get_my_driver_application') return application
    if (name === 'list_my_driver_vehicles') return vehicles
    if (name === 'get_my_driver_availability') return availability
    return []
  })
}

beforeEach(() => {
  authState.user = { id: 'drv' }
  actions.call.mockReset()
})

describe('DriverOnboarding', () => {
  it('asks anonymous visitors to sign in and loads nothing', () => {
    authState.user = null
    mount()
    expect(screen.getByRole('note')).toHaveTextContent(/Sign in to apply/)
    expect(actions.call).not.toHaveBeenCalled()
  })

  it('blocks submit until everything is provided, naming what is missing', async () => {
    serve([], [])
    mount()
    expect(await screen.findByRole('button', { name: 'Submit for review' })).toBeDisabled()
    expect(screen.getByText(/Still needed: .*Full name.*At least one vehicle/)).toBeInTheDocument()
  })

  it('saves then submits a complete application', async () => {
    serve([row('draft')], [vehicleRow('pending')])
    mount()
    const submit = await screen.findByRole('button', { name: 'Submit for review' })
    await waitFor(() => expect(submit).toBeEnabled())
    await userEvent.click(submit)
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('submit_driver_application', {}))
    const names = actions.call.mock.calls.map((c) => c[0])
    expect(names.indexOf('save_driver_application')).toBeLessThan(names.indexOf('submit_driver_application'))
  })

  it('shows the rejection reason and keeps the form editable', async () => {
    serve([row('rejected', { status_reason: 'Licence photo unreadable' })], [vehicleRow('pending')])
    mount()
    expect(await screen.findByText(/Reason: Licence photo unreadable/)).toBeInTheDocument()
    expect(screen.getByLabelText('Full name')).toBeEnabled()
  })

  it('locks the form once submitted and offers no availability', async () => {
    serve([row('submitted')], [vehicleRow('pending')])
    mount()
    expect(await screen.findByText(/reviewing your application/)).toBeInTheDocument()
    expect(screen.getByLabelText('Full name')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Availability' })).not.toBeInTheDocument()
  })

  it('shows vehicle approval states and the rejection reason', async () => {
    serve([row('submitted')], [vehicleRow('rejected', { status_reason: 'Plate mismatch' })])
    mount()
    expect(await screen.findByText('Rejected: Plate mismatch')).toBeInTheDocument()
  })

  it('publishes location and service area, then goes available', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: -33.87, longitude: 151.21 } }) } })
    serve([row('approved')], [vehicleRow('approved')], [{ available: 0, vehicle_id: null }])
    mount()
    await userEvent.selectOptions(await screen.findByLabelText('Service area'), '10')
    await userEvent.click(screen.getByRole('button', { name: 'Go available' }))
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('set_driver_availability', { available: 1, vehicle_id: 'v1' }))
    expect(actions.call).toHaveBeenCalledWith('update_driver_location', { lat: -33.87, lng: 151.21, service_radius_km: 10 })
    vi.unstubAllGlobals()
  })

  it('asks for location consent before going available, and records it with the notice version', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: -33.87, longitude: 151.21 } }) } })
    let granted = false
    actions.call.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
      if (name === 'get_my_location_consents') return granted ? [consentRow(true)] : []
      if (name === 'set_location_consent') { granted = params?.granted === 1; return undefined }
      if (name === 'get_my_driver_application') return [row('approved')]
      if (name === 'list_my_driver_vehicles') return [vehicleRow('approved')]
      if (name === 'get_my_driver_availability') return [{ available: 0, vehicle_id: null }]
      return []
    })
    mount()
    const region = await screen.findByRole('region', { name: 'Location while available for requests' })
    expect(region).toHaveTextContent(/deleted when you go offline/)
    const go = screen.getByRole('button', { name: 'Go available' })
    expect(go).toBeDisabled()
    await userEvent.click(go)
    expect(actions.call).not.toHaveBeenCalledWith('update_driver_location', expect.anything())
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(actions.call).toHaveBeenCalledWith('set_location_consent', { purpose: 'dispatch_availability', granted: 1, notice_version: NOTICE_VERSION })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go available' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Go available' }))
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('set_driver_availability', { available: 1, vehicle_id: 'v1' }))
    vi.unstubAllGlobals()
  })

  it('asks again when the notice wording has changed since the driver agreed', async () => {
    serve([row('approved')], [vehicleRow('approved')], [{ available: 0, vehicle_id: null }], [consentRow(true, 'an-older-version')])
    mount()
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go available' })).toBeDisabled()
  })

  it('withdrawing consent takes the driver offline in the screen too', async () => {
    let consents: unknown[] = [consentRow(true)]
    let available = 1
    actions.call.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
      if (name === 'get_my_location_consents') return consents
      if (name === 'set_location_consent') { consents = [consentRow(false)]; available = 0; expect(params).toMatchObject({ purpose: 'dispatch_availability', granted: 0 }); return undefined }
      if (name === 'get_my_driver_application') return [row('approved')]
      if (name === 'list_my_driver_vehicles') return [vehicleRow('approved')]
      if (name === 'get_my_driver_availability') return [{ available, vehicle_id: 'v1' }]
      return []
    })
    mount()
    expect(await screen.findByRole('button', { name: 'Go offline' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go available' })).toBeDisabled()
  })

  it('treats an unreadable consent record as not agreed', async () => {
    actions.call.mockImplementation(async (name: string) => {
      if (name === 'get_my_location_consents') throw new Error('offline')
      if (name === 'get_my_driver_application') return [row('approved')]
      if (name === 'list_my_driver_vehicles') return [vehicleRow('approved')]
      if (name === 'get_my_driver_availability') return [{ available: 0, vehicle_id: null }]
      return []
    })
    mount()
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go available' })).toBeDisabled()
  })

  it('does not go available when location access is denied', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (_ok: unknown, fail: () => void) => fail() } })
    serve([row('approved')], [vehicleRow('approved')], [{ available: 0, vehicle_id: null }])
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Go available' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(actions.call).not.toHaveBeenCalledWith('set_driver_availability', expect.anything())
    vi.unstubAllGlobals()
  })

  it('does not offer availability without an approved vehicle', async () => {
    serve([row('approved')], [vehicleRow('pending')])
    mount()
    expect(await screen.findByText(/need an approved vehicle/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go available' })).not.toBeInTheDocument()
  })

  it('blocks editing vehicles while suspended', async () => {
    serve([row('suspended', { status_reason: 'Safety report' })], [vehicleRow('approved')])
    mount()
    expect(await screen.findByText(/Reason: Safety report/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add vehicle' })).not.toBeInTheDocument()
  })
})
