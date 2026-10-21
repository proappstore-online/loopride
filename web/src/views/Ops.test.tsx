import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { authState, actions, roles } = vi.hoisted(() => ({
  authState: { user: { id: 'ops-1' } as { id: string } | null },
  actions: { call: vi.fn() },
  roles: { check: vi.fn() },
}))
vi.mock('../lib/app', () => ({ app: { actions, roles } }))
vi.mock('../lib/useAuth', () => ({ useAuth: () => ({ user: authState.user, loading: false }) }))

import Ops from './Ops'
import { renderWithRouter } from '../../test/router'

const mount = () => render(renderWithRouter(<Ops />, '/ops').ui)
const summary = { user_id: 'drv', status: 'submitted', full_name: 'Dana', phone: '555', licence_last4: '4567', licence_region: 'NSW', licence_expires: '2030-01-01', submitted_at: 1, vehicle_count: 1 }

beforeEach(() => {
  authState.user = { id: 'ops-1' }
  actions.call.mockReset()
  roles.check.mockReset()
  actions.call.mockImplementation(async (name: string) => (name === 'list_driver_applications' ? [summary] : []))
})

describe('Ops', () => {
  it('shows a gate, and loads no applications, without the ops role', async () => {
    roles.check.mockResolvedValue(false)
    mount()
    expect(await screen.findByText('Operations access required')).toBeInTheDocument()
    expect(actions.call).not.toHaveBeenCalled()
  })

  it('shows signed-out visitors the gate', async () => {
    authState.user = null
    mount()
    expect(await screen.findByText('Operations access required')).toBeInTheDocument()
  })

  it('lists submitted applications with a masked licence', async () => {
    roles.check.mockResolvedValue(true)
    mount()
    expect(await screen.findByText('Dana')).toBeInTheDocument()
    expect(screen.getByText(/Licence …4567/)).toBeInTheDocument()
    expect(actions.call).toHaveBeenCalledWith('list_driver_applications', { status: 'submitted' })
  })

  it('approves without a reason', async () => {
    roles.check.mockResolvedValue(true)
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('review_driver_application', { driver_user_id: 'drv', decision: 'approved', reason: null }))
  })

  it('refuses to reject without a reason, then sends it', async () => {
    roles.check.mockResolvedValue(true)
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(actions.call).not.toHaveBeenCalledWith('review_driver_application', expect.anything())
    await userEvent.type(screen.getByLabelText('Reason for Dana'), 'Licence expired')
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('review_driver_application', { driver_user_id: 'drv', decision: 'rejected', reason: 'Licence expired' }))
  })
})
