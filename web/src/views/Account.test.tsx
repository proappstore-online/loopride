import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { authState, actions } = vi.hoisted(() => ({
  authState: { user: null as { id: string; login: string } | null },
  actions: { call: vi.fn() },
}))
const deleteAccount = vi.hoisted(() => vi.fn())

vi.mock('../lib/app', () => ({
  app: { actions, kv: { delete: vi.fn() }, auth: { signIn: vi.fn(), get user() { return authState.user } } },
}))
vi.mock('../lib/useAuth', () => ({
  useAuth: () => ({ user: authState.user, loading: false, signOut: vi.fn(), deleteAccount }),
}))

import Account from './Account'
import { saveRide } from '../storage'
import { renderWithRouter } from '../../test/router'

const mount = () => render(renderWithRouter(<Account />, '/account').ui)

beforeEach(() => {
  authState.user = null
  actions.call.mockReset()
  deleteAccount.mockReset()
})

describe('Account (anonymous)', () => {
  it('explains the anonymous behaviour and upgrade path, and hides account-only sections', () => {
    mount()
    expect(screen.getByRole('note')).toHaveTextContent(/without an account/)
    expect(screen.getByRole('note')).toHaveTextContent(/added to your account automatically/)
    expect(screen.queryByRole('form', { name: 'Profile' })).not.toBeInTheDocument()
    expect(screen.queryByText('Delete my account')).not.toBeInTheDocument()
    expect(actions.call).not.toHaveBeenCalled()
  })

  it("shows this device's rides in their tabs", async () => {
    saveRide({ id: 'a', pickup: 'A', pickupCoord: null, dropoff: 'Opera House', dropoffCoord: null, days: [], time: '08:00', driverName: '', paused: false, createdAt: 1, bookingType: 'now' })
    mount()
    expect(screen.getByRole('tab', { name: 'Active (1)' })).toBeInTheDocument()
    expect(screen.getByText('Opera House')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Completed (0)' }))
    expect(screen.getByText('No completed trips.')).toBeInTheDocument()
  })
})

describe('Account (signed in)', () => {
  beforeEach(() => {
    authState.user = { id: 'u1', login: 'sam' }
    actions.call.mockImplementation(async (name: string) => {
      if (name === 'list_trip_history')
        return [
          { id: 'r1', booking_type: 'now', status: 'cancelled', pickup_label: 'A', dropoff_label: 'Gone trip', trip_status: 'cancelled', fare_cents: 1250, updated_at: 1_700_000_000_000 },
          { id: 'r2', booking_type: 'now', status: 'completed', pickup_label: 'C', dropoff_label: 'Done trip', trip_status: 'completed', fare_cents: null, updated_at: 1_700_000_000_000 },
        ]
      if (name === 'list_saved_places') return [{ id: 'p1', label: 'Home', address: '1 Main St', lat: null, lng: null }]
      return []
    })
  })

  it('shows DB history including cancelled trips, with no anonymous banner', async () => {
    mount()
    await userEvent.click(await screen.findByRole('tab', { name: 'Cancelled (1)' }))
    expect(screen.getByText('Gone trip')).toBeInTheDocument()
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Completed (1)' }))
    expect(screen.getByText('Done trip')).toBeInTheDocument()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('saves contact preferences', async () => {
    mount()
    await userEvent.type(await screen.findByLabelText('Name'), 'Sam')
    await userEvent.click(screen.getByLabelText('Text messages'))
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() =>
      expect(actions.call).toHaveBeenCalledWith('save_rider_profile', expect.objectContaining({ display_name: 'Sam', notify_sms: 1 })),
    )
  })

  it('lists, adds and removes saved places', async () => {
    mount()
    expect(await screen.findByText('1 Main St')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Place name'), 'Work')
    await userEvent.type(screen.getByLabelText('Place address'), '2 High St')
    await userEvent.click(screen.getByRole('button', { name: 'Add place' }))
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('save_place', expect.objectContaining({ label: 'Work', address: '2 High St' })))
    await userEvent.click(screen.getByRole('button', { name: 'Remove Home' }))
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('delete_place', { place_id: 'p1' }))
  })

  it('requires typing DELETE before erasing data and the account', async () => {
    mount()
    const button = await screen.findByRole('button', { name: 'Delete my account' })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE')
    await userEvent.click(button)
    await waitFor(() => expect(deleteAccount).toHaveBeenCalled())
    expect(actions.call).toHaveBeenCalledWith('delete_my_rider_data', {})
  })
})
