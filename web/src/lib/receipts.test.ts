import { beforeEach, describe, expect, it, vi } from 'vitest'

const { actions } = vi.hoisted(() => ({ actions: { call: vi.fn() } }))
vi.mock('./app', () => ({ app: { actions } }))

import { BASIS_LABEL, loadEarnings, loadReceipt, loadReceipts, money } from './receipts'

beforeEach(() => actions.call.mockReset())

const row = (extra = {}) => ({ receipt_no: 'RCT-1', trip_id: 't1', request_id: 'r1', basis: 'fare', currency: 'USD', quoted_cents: 1150, base_cents: 200, distance_cents: 550, time_cents: 250, booking_fee_cents: 150, min_adjust_cents: 0, surge_milli: 1000, final_cents: 1150, tax_rate_bp: 0, tax_cents: 0, credits_cents: 100, total_cents: 1050, pickup_label: 'A', dropoff_label: 'B', finalized_at: 5, ...extra })

describe('receipts client', () => {
  it('maps a statement and reads it by ride', async () => {
    actions.call.mockResolvedValueOnce([row()])
    expect(await loadReceipt('r1')).toMatchObject({ receiptNo: 'RCT-1', basis: 'fare', quotedCents: 1150, finalCents: 1150, creditsCents: 100, totalCents: 1050, pickup: 'A' })
    expect(actions.call).toHaveBeenCalledWith('get_receipt', { request_id: 'r1' })
    actions.call.mockResolvedValueOnce([])
    expect(await loadReceipt('r1')).toBeNull()
  })

  it('lists receipts and earnings', async () => {
    actions.call.mockResolvedValueOnce([row(), row({ receipt_no: 'RCT-2' })])
    expect((await loadReceipts()).map((r) => r.receiptNo)).toEqual(['RCT-1', 'RCT-2'])
    expect(actions.call).toHaveBeenLastCalledWith('list_my_receipts', { limit: 100 })
    actions.call.mockResolvedValueOnce([{ receipt_no: 'RCT-1', trip_id: 't1', basis: 'fare', final_cents: 1000, tax_cents: 0, platform_fee_cents: 100, driver_payout_cents: 900, credits_cents: 0, finalized_at: 5 }])
    expect(await loadEarnings()).toEqual([{ receiptNo: 'RCT-1', tripId: 't1', basis: 'fare', finalCents: 1000, taxCents: 0, platformFeeCents: 100, payoutCents: 900, creditsCents: 0, finalizedAt: 5 }])
  })

  it('formats money and labels every basis', () => {
    expect(money(1150)).toBe('$11.50')
    expect(money(5, 'EUR')).toBe('0.05 EUR')
    expect(Object.keys(BASIS_LABEL).sort()).toEqual(['cancellation_fee', 'fare', 'no_show_fee', 'none'])
  })
})
