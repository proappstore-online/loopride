import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('../lib/app', () => ({ app: { actions } }))

import PrivacySettings from './PrivacySettings'
import { NOTICE_VERSION } from '../lib/privacy'

let rows: { purpose: string; granted: number; notice_version: string; granted_at: number | null; withdrawn_at: number | null }[]

beforeEach(() => {
  actions.call.mockReset()
  rows = [{ purpose: 'dispatch_availability', granted: 1, notice_version: NOTICE_VERSION, granted_at: 1, withdrawn_at: null }]
  actions.call.mockImplementation(async (name: string, params?: { purpose: string; granted: number }) => {
    if (name === 'get_my_location_consents') return rows
    if (name === 'set_location_consent' && params) {
      rows = [...rows.filter((r) => r.purpose !== params.purpose), { purpose: params.purpose, granted: params.granted, notice_version: NOTICE_VERSION, granted_at: 1, withdrawn_at: params.granted ? null : 2 }]
    }
    return undefined
  })
})

describe('PrivacySettings', () => {
  it('shows each location purpose with its notice and current choice', async () => {
    render(<PrivacySettings />)
    const dispatch = await screen.findByRole('region', { name: 'Location while available for requests' })
    const trip = screen.getByRole('region', { name: 'Location during a trip' })
    await waitFor(() => expect(dispatch).toHaveTextContent('Allowed'))
    await waitFor(() => expect(trip).toHaveTextContent(/Allow$/))
    expect(trip).toHaveTextContent(/rounded to about 11 m/)
  })

  it('states how long short-lived data is kept and that the rest stays until deletion', async () => {
    render(<PrivacySettings />)
    expect(await screen.findByText('Live trip positions: 24 hours')).toBeInTheDocument()
    expect(screen.getByText('Trip evidence snapshots: 30 days')).toBeInTheDocument()
    expect(screen.getByText('Everything else is kept until you delete your account.')).toBeInTheDocument()
  })

  it('withdraws a consent and shows the effect, then allows it again', async () => {
    render(<PrivacySettings />)
    const dispatch = await screen.findByRole('region', { name: 'Location while available for requests' })
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw' }))
    expect(actions.call).toHaveBeenCalledWith('set_location_consent', { purpose: 'dispatch_availability', granted: 0, notice_version: NOTICE_VERSION })
    await waitFor(() => expect(dispatch).not.toHaveTextContent('Allowed'))
    await userEvent.click(screen.getAllByRole('button', { name: 'Allow' })[0])
    await waitFor(() => expect(actions.call).toHaveBeenCalledWith('set_location_consent', expect.objectContaining({ granted: 1 })))
  })

  it('says so when the choice could not be saved, and keeps the previous state', async () => {
    render(<PrivacySettings />)
    const dispatch = await screen.findByRole('region', { name: 'Location while available for requests' })
    await waitFor(() => expect(dispatch).toHaveTextContent('Allowed'))
    actions.call.mockImplementation(async (name: string) => { if (name === 'set_location_consent') throw new Error('offline'); return rows })
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    expect(await screen.findByText("Couldn't save your choice. Try again.")).toBeInTheDocument()
    expect(dispatch).toHaveTextContent('Allowed')
  })
})
