import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { authState, actions, roles, toast } = vi.hoisted(() => ({
  authState: { user: { id: 'ops-1' } as { id: string } | null },
  actions: { call: vi.fn() },
  roles: { check: vi.fn() },
  toast: vi.fn(),
}))
vi.mock('../lib/app', () => ({ app: { actions, roles } }))
vi.mock('../lib/useAuth', () => ({ useAuth: () => ({ user: authState.user, loading: false }) }))
vi.mock('../lib/toast', () => ({ showToast: toast }))

import Ops from './Ops'
import { renderWithRouter } from '../../test/router'

const mount = () => render(renderWithRouter(<Ops />, '/ops').ui)
const hold = (...granted: string[]) => roles.check.mockImplementation(async (r: string) => granted.includes(r))
const calls = (name: string) => actions.call.mock.calls.filter((c) => c[0] === name).map((c) => c[1])

const summary = (extra = {}) => ({ trip_id: 'r1:trip', request_id: 'r1', rider_id: 'rider-1', driver_user_id: 'd1', phase: 'completed', outcome: 'completed', vehicle_class: 'share', created_at: 1, updated_at: 1_700_000_000_000, final_cents: 1500, dispatch_status: 'matched', dispute_open: 0, ...extra })
const detail = (extra = {}) => ({ ...summary(), status: 'completed', started_at: 1, ended_at: 2, cancelled_by_role: null, cancel_code: null, cancel_fee_cents: 0, fee_policy: null, booking_type: 'now', assignment_status: 'accepted', dispatch_attempts: 2, receipt_no: 'RCT-1', credits_cents: 0, disputes: 0, disputes_open: 0, refund_requests: 0, ...extra })

let serve: Record<string, unknown>
beforeEach(() => {
  authState.user = { id: 'ops-1' }
  actions.call.mockReset()
  roles.check.mockReset()
  toast.mockReset()
  serve = {
    ops_search_trips: [summary(), summary({ trip_id: 'r2:trip', request_id: 'r2', phase: 'en_route', outcome: null, final_cents: null })],
    ops_get_trip: [detail()],
    ops_get_trip_offers: [{ attempt: 1, driver_user_id: 'd0', status: 'declined', distance_km2: 4, offered_at: 1, responded_at: 2 }, { attempt: 2, driver_user_id: 'd1', status: 'completed', distance_km2: 1, offered_at: 3, responded_at: 4 }],
    ops_get_trip_timeline: [{ kind: 'transition', name: 'scheduled', actor: 'driver:d1', detail: '', at: 1 }, { kind: 'event', name: 'completed', actor: 'driver:d1', detail: '', at: 2 }],
    ops_get_trip_evidence: [{ kind: 'arrived', captured_at: 1, age_ms: 3000, accuracy_m: 8, proximity: 'within_150m' }, { kind: 'ended', captured_at: 2, age_ms: 1000, accuracy_m: 8, proximity: 'farther' }],
    list_driver_applications: [{ user_id: 'drv', status: 'submitted', initial: 'D.', phone_masked: '***00', licence_last4: '4567', licence_region: 'NSW', licence_expires: '2030-01-01', submitted_at: 1, updated_at: 1, vehicle_count: 1 }],
    ops_list_disputes: [{ rider_id: 'rider-1', trip_id: 'r1:trip', opened_by: 'rider-1', opened_role: 'rider', reason_code: 'cancel_fee', note: 'unfair', status: 'open', opened_at: 1, outcome: 'rider_cancelled', cancel_fee_cents: 500 }],
    ops_list_refund_requests: [{ rider_id: 'rider-1', request_key: 'k1', trip_id: 'r1:trip', amount_cents: 600, reason_code: 'overcharged', note: 'meter ran long', status: 'requested', requested_by: 'ops-2', requested_at: 1 }],
    ops_list_escalations: [{ id: 'e1', rider_id: 'rider-1', trip_id: 'r1:trip', driver_user_id: null, level: 'safety', reason_code: 'safety', note: 'incident', status: 'open', opened_by: 'ops-2', opened_at: 1 }],
    ops_list_audit: [{ at: 5, action: 'trip_cancelled', actor_id: 'ops-2', rider_id: 'rider-1', trip_id: 'r1:trip', driver_user_id: null, reason_code: 'vehicle_issue', note: 'tow', amount_cents: null }],
  }
  actions.call.mockImplementation(async (name: string) => serve[name] ?? undefined)
})

describe('Ops console: access', () => {
  it('shows a gate, and loads nothing, without the ops role', async () => {
    hold()
    mount()
    expect(await screen.findByText('Operations access required')).toBeInTheDocument()
    expect(actions.call).not.toHaveBeenCalled()
  })

  it('shows signed-out visitors the gate', async () => {
    authState.user = null
    mount()
    expect(await screen.findByText('Operations access required')).toBeInTheDocument()
  })

  it('says personal details are hidden for ops, and offers no reveal control', async () => {
    hold('ops')
    mount()
    expect(await screen.findByText('Personal details are hidden')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await screen.findByRole('article')
    expect(screen.queryByText(/Personal details \(ops_pii\)/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show names and addresses/ })).not.toBeInTheDocument()
  })

  it('offers every section', async () => {
    hold('ops')
    mount()
    await screen.findByRole('tablist', { name: 'Console sections' })
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Trips', 'Drivers', 'Disputes', 'Refunds', 'Escalations', 'Audit'])
  })
})

describe('Ops console: trips', () => {
  beforeEach(() => hold('ops'))

  it('searches by exact id and status', async () => {
    mount()
    await screen.findByRole('button', { name: /r1:trip/ })
    expect(calls('ops_search_trips')[0]).toEqual({ q: null, status: null, limit: 50 })
    await userEvent.type(screen.getByLabelText('Search trips'), 'rider-1')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'completed')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(calls('ops_search_trips').at(-1)).toEqual({ q: 'rider-1', status: 'completed', limit: 50 }))
  })

  it('explains that matching is exact when nothing is found', async () => {
    serve.ops_search_trips = []
    mount()
    expect(await screen.findByText(/Searches match whole ids exactly/)).toBeInTheDocument()
  })

  it('inspects a trip: assignment, dispatch history, timeline and location evidence without coordinates', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    const trip = await screen.findByRole('article', { name: 'Trip r1:trip' })
    expect(within(trip).getByText('accepted')).toBeInTheDocument()
    expect(within(trip).getByText('matched (2 offers)')).toBeInTheDocument()
    expect(within(trip).getByText(/#1 d0: declined, 2.0 km away/)).toBeInTheDocument()
    expect(within(trip).getByText(/#2 d1: completed/)).toBeInTheDocument()
    expect(within(trip).getByText('scheduled')).toBeInTheDocument()
    expect(within(trip).getByText(/driver within 150 m of the pickup/)).toBeInTheDocument()
    expect(within(trip).getByText(/driver more than 2 km away of the drop-off/)).toBeInTheDocument()
    expect(calls('ops_get_trip')[0]).toEqual({ rider_id: 'rider-1', trip_id: 'r1:trip' })
    expect(calls('ops_get_trip_offers')[0]).toEqual({ rider_id: 'rider-1', request_id: 'r1' })
  })

  it('cancels an unfinished trip only with a reason code and a note', async () => {
    serve.ops_search_trips = [summary({ phase: 'en_route', outcome: null })]
    serve.ops_get_trip = [detail({ phase: 'en_route', outcome: null, status: 'en_route' })]
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel trip' }))
    const form = screen.getByRole('group', { name: 'Cancel trip' })
    const submit = within(form).getByRole('button', { name: 'Cancel trip' })
    expect(submit).toBeDisabled()
    await userEvent.selectOptions(within(form).getByLabelText('Reason'), 'vehicle_issue')
    expect(submit).toBeDisabled() // a code alone is not enough
    await userEvent.type(within(form).getByLabelText('Note'), 'tow truck called')
    await userEvent.clear(within(form).getByLabelText(/Cancellation fee/))
    await userEvent.type(within(form).getByLabelText(/Cancellation fee/), '4.50')
    await userEvent.click(submit)
    await waitFor(() => expect(calls('ops_cancel_trip')).toEqual([{ rider_id: 'rider-1', trip_id: 'r1:trip', reason_code: 'vehicle_issue', note: 'tow truck called', fee_cents: 450 }]))
    expect(toast).toHaveBeenCalledWith({ message: 'Trip cancelled' })
  })

  it('offers cancel only for unfinished trips, and credit and refund only for finished ones', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ })) // completed
    const actionsBar = await screen.findByRole('group', { name: 'Support actions' })
    expect(within(actionsBar).queryByRole('button', { name: 'Cancel trip' })).not.toBeInTheDocument()
    expect(within(actionsBar).getByRole('button', { name: 'Credit' })).toBeInTheDocument()
    expect(within(actionsBar).getByRole('button', { name: 'Request refund' })).toBeInTheDocument()
    expect(within(actionsBar).getByRole('button', { name: 'Escalate' })).toBeInTheDocument()
  })

  it('credits with a reason and note, in cents', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Credit' }))
    const form = screen.getByRole('group', { name: 'Credit' })
    await userEvent.type(within(form).getByLabelText('Amount (USD)'), '2.50')
    await userEvent.selectOptions(within(form).getByLabelText('Reason'), 'goodwill')
    await userEvent.type(within(form).getByLabelText('Note'), 'late pickup')
    await userEvent.click(within(form).getByRole('button', { name: 'Apply credit' }))
    await waitFor(() => expect(calls('ops_credit_trip')).toHaveLength(1))
    expect(calls('ops_credit_trip')[0]).toMatchObject({ rider_id: 'rider-1', trip_id: 'r1:trip', amount_cents: 250, reason_code: 'goodwill', note: 'late pickup' })
    expect(String((calls('ops_credit_trip')[0] as { request_key: string }).request_key).length).toBeGreaterThan(8) // a retry key
  })

  it('requests a refund and says that no money moves', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Request refund' }))
    const form = screen.getByRole('group', { name: 'Request refund' })
    expect(within(form).getByText(/No money moves while payments are not enabled/)).toBeInTheDocument()
    await userEvent.type(within(form).getByLabelText('Amount (USD)'), '6')
    await userEvent.selectOptions(within(form).getByLabelText('Reason'), 'overcharged')
    await userEvent.type(within(form).getByLabelText('Note'), 'meter ran long')
    await userEvent.click(within(form).getByRole('button', { name: 'Request refund' }))
    await waitFor(() => expect(calls('ops_request_refund')).toHaveLength(1))
    expect(calls('ops_request_refund')[0]).toMatchObject({ amount_cents: 600, reason_code: 'overcharged' })
  })

  it('escalates with a level, a reason code and a note', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Escalate' }))
    const form = screen.getByRole('group', { name: 'Escalate' })
    await userEvent.selectOptions(within(form).getByLabelText('Escalate to'), 'legal')
    await userEvent.selectOptions(within(form).getByLabelText('Reason'), 'legal_request')
    await userEvent.type(within(form).getByLabelText('Note'), 'subpoena received')
    await userEvent.click(within(form).getByRole('button', { name: 'Escalate' }))
    await waitFor(() => expect(calls('ops_escalate')).toHaveLength(1))
    expect(calls('ops_escalate')[0]).toMatchObject({ rider_id: 'rider-1', trip_id: 'r1:trip', driver_user_id: null, level: 'legal', reason_code: 'legal_request', note: 'subpoena received' })
  })

  it('shows a refusal instead of pretending the action worked', async () => {
    serve.ops_search_trips = [summary({ phase: 'en_route', outcome: null })]
    serve.ops_get_trip = [detail({ phase: 'en_route', outcome: null })]
    actions.call.mockImplementation(async (name: string) => {
      if (name === 'ops_cancel_trip') throw new Error('403')
      return serve[name] ?? undefined
    })
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel trip' }))
    const form = screen.getByRole('group', { name: 'Cancel trip' })
    await userEvent.selectOptions(within(form).getByLabelText('Reason'), 'other')
    await userEvent.type(within(form).getByLabelText('Note'), 'x')
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel trip' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: 'That action was refused' }))
  })
})

describe('Ops console: personal data', () => {
  beforeEach(() => hold('ops', 'ops_pii'))

  it('logs a reason before showing names and addresses, and the reason is required', async () => {
    serve.ops_get_trip_pii = [{ trip_id: 'r1:trip', pickup_label: '12 Secret Lane', dropoff_label: '1 Airport Rd', rider_name: 'Rita Rider', driver_name: 'Dana Driver', plate: 'RS-1' }]
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    const show = await screen.findByRole('button', { name: 'Show names and addresses' })
    expect(show).toBeDisabled()
    expect(screen.queryByText('12 Secret Lane')).not.toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Why do you need these?'), 'support_ticket')
    await userEvent.click(show)
    expect(await screen.findByText('12 Secret Lane')).toBeInTheDocument()
    expect(screen.getByText('Dana Driver')).toBeInTheDocument()
    const order = actions.call.mock.calls.map((c) => c[0])
    expect(order.indexOf('ops_log_access')).toBeGreaterThan(-1)
    expect(order.indexOf('ops_log_access')).toBeLessThan(order.indexOf('ops_get_trip_pii'))
    expect(calls('ops_log_access')[0]).toEqual({ scope: 'trip_pii', rider_id: 'rider-1', trip_id: 'r1:trip', driver_user_id: null, reason_code: 'support_ticket' })
  })

  it('shows exact evidence locations only after logging an evidence access', async () => {
    serve.ops_get_trip_evidence_pii = [{ kind: 'arrived', lat: -33.86881, lng: 151.20931, accuracy_m: 8, captured_at: 1 }]
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await userEvent.selectOptions(await screen.findByLabelText('Why do you need these?'), 'dispute')
    await userEvent.click(screen.getByRole('button', { name: 'Show exact locations' }))
    expect(await screen.findByText(/arrived: -33.86881, 151.20931/)).toBeInTheDocument()
    expect(calls('ops_log_access')[0]).toMatchObject({ scope: 'evidence', reason_code: 'dispute' })
  })

  it('does not reveal anything if the server returns nothing', async () => {
    serve.ops_get_trip_pii = []
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /r1:trip/ }))
    await userEvent.selectOptions(await screen.findByLabelText('Why do you need these?'), 'dispute')
    await userEvent.click(screen.getByRole('button', { name: 'Show names and addresses' }))
    await waitFor(() => expect(calls('ops_get_trip_pii')).toHaveLength(1))
    expect(screen.queryByText('Rider')).toBeInTheDocument() // the trip's own "Rider" row, not a name
    expect(screen.queryByText('Rita Rider')).not.toBeInTheDocument()
  })
})

describe('Ops console: drivers', () => {
  beforeEach(() => hold('ops'))
  const openDrivers = async () => {
    mount()
    await userEvent.click(await screen.findByRole('tab', { name: 'Drivers' }))
  }

  it('lists applications redacted: an initial, a masked phone, the last licence digits', async () => {
    await openDrivers()
    expect(await screen.findByText(/Phone \*\*\*00 · Licence …4567 \(NSW\)/)).toBeInTheDocument()
    expect(screen.getByText(/· D\./)).toBeInTheDocument()
    expect(calls('list_driver_applications')[0]).toEqual({ status: 'submitted' })
  })

  it('approves without a reason, and rejecting needs one', async () => {
    await openDrivers()
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(calls('review_driver_application')).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(calls('review_driver_application')).toEqual([{ driver_user_id: 'drv', decision: 'approved', reason: null }]))
  })

  it('suspends an approved driver only with a reason code and a note', async () => {
    serve.list_driver_applications = [{ ...(serve.list_driver_applications as object[])[0], status: 'approved' }]
    await openDrivers()
    await userEvent.click(await screen.findByRole('tab', { name: 'approved' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend' }))
    const form = screen.getByRole('group', { name: 'Suspend driver' })
    const submit = within(form).getByRole('button', { name: 'Suspend' })
    expect(submit).toBeDisabled()
    await userEvent.selectOptions(within(form).getByLabelText('Reason'), 'safety')
    expect(submit).toBeDisabled()
    await userEvent.type(within(form).getByLabelText('Note'), 'two complaints this week')
    await userEvent.click(submit)
    await waitFor(() => expect(calls('ops_suspend_driver')).toEqual([{ driver_user_id: 'drv', reason_code: 'safety', note: 'two complaints this week' }]))
  })

  it('reinstates a suspended driver with a code and a note, and offers no suspend', async () => {
    serve.list_driver_applications = [{ ...(serve.list_driver_applications as object[])[0], status: 'suspended' }]
    await openDrivers()
    await userEvent.click(await screen.findByRole('tab', { name: 'suspended' }))
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Reinstate' }))
    const form = screen.getByRole('group', { name: 'Reinstate driver' })
    await userEvent.selectOptions(within(form).getByLabelText('Reason'), 'review_complete')
    await userEvent.type(within(form).getByLabelText('Note'), 'cleared')
    await userEvent.click(within(form).getByRole('button', { name: 'Reinstate' }))
    await waitFor(() => expect(calls('ops_reinstate_driver')).toEqual([{ driver_user_id: 'drv', reason_code: 'review_complete', note: 'cleared' }]))
  })

  it('has no way to see licence details without the ops_pii role', async () => {
    await openDrivers()
    await screen.findByText(/Licence …4567/)
    expect(screen.queryByRole('button', { name: 'Show personal details' })).not.toBeInTheDocument()
  })
})

describe('Ops console: drivers with personal-data access', () => {
  it('logs a reason, then shows the full record', async () => {
    hold('ops', 'ops_pii')
    serve.get_driver_application_detail = [{ user_id: 'drv', full_name: 'Dana Driver', phone: '555-0100', licence_number: 'D1234567', licence_region: 'NSW', licence_expires: '2030-01-01' }]
    mount()
    await userEvent.click(await screen.findByRole('tab', { name: 'Drivers' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show personal details' }))
    const show = screen.getByRole('button', { name: 'Show details' })
    expect(show).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Why do you need these?'), 'support_ticket')
    await userEvent.click(show)
    expect(await screen.findByText('D1234567 (NSW, expires 2030-01-01)')).toBeInTheDocument()
    expect(calls('ops_log_access')[0]).toEqual({ scope: 'driver_pii', rider_id: null, trip_id: null, driver_user_id: 'drv', reason_code: 'support_ticket' })
  })
})

describe('Ops console: queues and audit', () => {
  beforeEach(() => hold('ops'))
  const open = async (tab: string) => {
    mount()
    await userEvent.click(await screen.findByRole('tab', { name: tab }))
  }

  it('resolves a dispute with a note, optionally waiving the fee', async () => {
    await open('Disputes')
    const uphold = await screen.findByRole('button', { name: 'Uphold' })
    expect(uphold).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Decision note'), 'driver was late')
    await userEvent.click(screen.getByLabelText(/Waive the \$5.00 fee if upheld/))
    await userEvent.click(uphold)
    await waitFor(() => expect(calls('ops_resolve_dispute')).toEqual([{ rider_id: 'rider-1', trip_id: 'r1:trip', opened_by: 'rider-1', decision: 'upheld', note: 'driver was late', waive_fee: 1 }]))
  })

  it('decides a refund request with a note, and says approval moves no money', async () => {
    await open('Refunds')
    expect(await screen.findByText(/No money moves while payments are not enabled/)).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Decision note'), 'checked the meter')
    await userEvent.click(approve)
    await waitFor(() => expect(calls('ops_decide_refund')).toEqual([{ rider_id: 'rider-1', request_key: 'k1', decision: 'approved', note: 'checked the meter' }]))
  })

  it('shows the second-person rule being enforced when the server refuses', async () => {
    actions.call.mockImplementation(async (name: string) => {
      if (name === 'ops_decide_refund') throw new Error('refused')
      return serve[name] ?? undefined
    })
    await open('Refunds')
    await userEvent.type(await screen.findByLabelText('Decision note'), 'ok')
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: 'That action was refused' }))
  })

  it('resolves an escalation with a note', async () => {
    await open('Escalations')
    expect(await screen.findByText('safety · safety')).toBeInTheDocument()
    const resolve = screen.getByRole('button', { name: 'Resolve' })
    expect(resolve).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Resolution note'), 'called the driver')
    await userEvent.click(resolve)
    await waitFor(() => expect(calls('ops_resolve_escalation')).toEqual([{ request_key: 'e1', note: 'called the driver' }]))
  })

  it('lists the audit trail with actor, time, reason and note, and filters it', async () => {
    await open('Audit')
    const entry = await screen.findByText('trip cancelled')
    expect(entry.parentElement).toHaveTextContent('by ops-2')
    expect(screen.getByText(/vehicle_issue/)).toBeInTheDocument()
    expect(screen.getByText('“tow”')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Filter by trip id'), 'r1:trip')
    await userEvent.type(screen.getByLabelText('Filter by staff member'), 'ops-2')
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }))
    await waitFor(() => expect(calls('ops_list_audit').at(-1)).toEqual({ trip_id: 'r1:trip', actor: 'ops-2', limit: 100 }))
  })

  it('says when there is nothing in a queue', async () => {
    serve.ops_list_disputes = []
    await open('Disputes')
    expect(await screen.findByText('No open disputes.')).toBeInTheDocument()
  })
})
