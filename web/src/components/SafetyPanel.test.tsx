import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { actions, toast } = vi.hoisted(() => ({ actions: { call: vi.fn() }, toast: vi.fn() }))
vi.mock('../lib/app', () => ({ app: { actions } }))
vi.mock('../lib/toast', () => ({ showToast: toast }))

import SafetyPanel from './SafetyPanel'
import { expectNoA11yViolations } from '../../test/axe'
import { SAFETY_COPY } from '../lib/safety'

let recorded: boolean
beforeEach(() => {
  actions.call.mockReset()
  toast.mockReset()
  recorded = true
  actions.call.mockImplementation(async (name: string) => {
    if (name === 'list_my_safety_reports') return recorded ? [{ id: `rider-1:${calls('submit_safety_report').at(-1)?.request_key}` }] : []
    return undefined
  })
})
const calls = (name: string) => actions.call.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>)
const mount = (role: 'rider' | 'driver' = 'rider', onClose = vi.fn()) => { render(<SafetyPanel riderId="rider-1" tripId="r1:trip" role={role} onClose={onClose} />); return onClose }

describe('SafetyPanel', () => {
  it('puts the emergency guidance and its limits before the form', () => {
    mount()
    const group = screen.getByRole('group', { name: 'Safety' })
    expect(screen.getByRole('alert')).toHaveTextContent(SAFETY_COPY.emergency)
    expect(group).toHaveTextContent(SAFETY_COPY.limits)
    expect(group.innerHTML.indexOf('emergency services')).toBeLessThan(group.innerHTML.indexOf('<select'))
  })

  it('speaks about the other person for each role and offers every category', () => {
    mount('driver')
    expect(screen.getByLabelText('What happened with the rider?')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(9) // placeholder + 8 categories
  })

  it('cannot be sent without choosing what happened', async () => {
    mount()
    expect(screen.getByRole('button', { name: 'Send safety report' })).toBeDisabled()
    expect(calls('submit_safety_report')).toEqual([])
  })

  it('sends the trip with the category and note, then confirms it was recorded', async () => {
    const onClose = mount()
    await userEvent.selectOptions(screen.getByLabelText(/What happened/), 'unsafe_driving')
    await userEvent.type(screen.getByLabelText('Details (optional)'), 'ran a red light')
    await userEvent.click(screen.getByRole('button', { name: 'Send safety report' }))
    expect(await screen.findByRole('status')).toHaveTextContent(SAFETY_COPY.sent)
    expect(calls('submit_safety_report')).toEqual([expect.objectContaining({ rider_id: 'rider-1', trip_id: 'r1:trip', category: 'unsafe_driving', note: 'ran a red light', request_key: expect.any(String) })])
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('tells the person an urgent report was marked urgent and still points to emergency services', async () => {
    mount()
    await userEvent.selectOptions(screen.getByLabelText(/What happened/), 'assault')
    await userEvent.click(screen.getByRole('button', { name: 'Send safety report' }))
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(SAFETY_COPY.sentUrgent)
    expect(screen.getByRole('alert')).toHaveTextContent(SAFETY_COPY.emergency) // still on screen
  })

  it('does not claim success when the server did not record the report, and a retry reuses the same key', async () => {
    recorded = false
    mount()
    await userEvent.selectOptions(screen.getByLabelText(/What happened/), 'harassment')
    await userEvent.click(screen.getByRole('button', { name: 'Send safety report' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: "Couldn't send your report. Try again." }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send safety report' })).toBeEnabled()
    recorded = true
    await userEvent.click(screen.getByRole('button', { name: 'Send safety report' }))
    await screen.findByRole('status')
    const keys = calls('submit_safety_report').map((c) => c.request_key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('shows an error when the call itself fails', async () => {
    actions.call.mockRejectedValue(new Error('offline'))
    mount()
    await userEvent.selectOptions(screen.getByLabelText(/What happened/), 'other')
    await userEvent.click(screen.getByRole('button', { name: 'Send safety report' }))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('has no accessibility violations before and after sending', async () => {
    const { container } = render(<SafetyPanel riderId="rider-1" tripId="r1:trip" role="rider" onClose={vi.fn()} />)
    await expectNoA11yViolations(container)
    await userEvent.selectOptions(screen.getByLabelText(/What happened/), 'other')
    await userEvent.click(screen.getByRole('button', { name: 'Send safety report' }))
    await screen.findByRole('status')
    await expectNoA11yViolations(container)
  })

})
