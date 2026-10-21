import { app } from './app'

/**
 * Receipts and driver earnings. Everything shown here is read from the
 * immutable fare statement the server wrote when the trip ended (mcp.json ›
 * get_receipt / list_my_receipts / list_my_earnings). No payment is collected
 * in the app, so nothing here handles card details or credentials; see
 * docs/adr/0001-fare-collection-payouts-receipts.md.
 */
export type Basis = 'fare' | 'cancellation_fee' | 'no_show_fee' | 'none'

export interface Receipt {
  receiptNo: string
  tripId: string
  requestId: string
  basis: Basis
  currency: string
  quotedCents: number
  baseCents: number | null
  distanceCents: number | null
  timeCents: number | null
  bookingFeeCents: number | null
  minAdjustCents: number | null
  surgeMilli: number | null
  finalCents: number
  taxRateBp: number
  taxCents: number
  creditsCents: number
  totalCents: number
  pickup: string | null
  dropoff: string | null
  finalizedAt: number
}

interface ReceiptRow {
  receipt_no: string
  trip_id: string
  request_id: string
  basis: Basis
  currency: string
  quoted_cents: number
  base_cents: number | null
  distance_cents: number | null
  time_cents: number | null
  booking_fee_cents: number | null
  min_adjust_cents: number | null
  surge_milli: number | null
  final_cents: number
  tax_rate_bp: number
  tax_cents: number
  credits_cents: number
  total_cents: number
  pickup_label: string | null
  dropoff_label: string | null
  finalized_at: number
}

const call = <T>(name: string, params: Record<string, unknown> = {}) => app.actions.call<T>(name, params)

const fromRow = (r: ReceiptRow): Receipt => ({
  receiptNo: r.receipt_no,
  tripId: r.trip_id,
  requestId: r.request_id,
  basis: r.basis,
  currency: r.currency,
  quotedCents: r.quoted_cents,
  baseCents: r.base_cents,
  distanceCents: r.distance_cents,
  timeCents: r.time_cents,
  bookingFeeCents: r.booking_fee_cents,
  minAdjustCents: r.min_adjust_cents,
  surgeMilli: r.surge_milli,
  finalCents: r.final_cents,
  taxRateBp: r.tax_rate_bp,
  taxCents: r.tax_cents,
  creditsCents: r.credits_cents,
  totalCents: r.total_cents,
  pickup: r.pickup_label,
  dropoff: r.dropoff_label,
  finalizedAt: r.finalized_at,
})

export async function loadReceipt(requestId: string): Promise<Receipt | null> {
  const [row] = await call<ReceiptRow[]>('get_receipt', { request_id: requestId })
  return row ? fromRow(row) : null
}

export async function loadReceipts(): Promise<Receipt[]> {
  return (await call<ReceiptRow[]>('list_my_receipts', { limit: 100 })).map(fromRow)
}

export interface Earning {
  receiptNo: string
  tripId: string
  basis: Basis
  finalCents: number
  taxCents: number
  platformFeeCents: number
  payoutCents: number
  creditsCents: number
  finalizedAt: number
}

export async function loadEarnings(): Promise<Earning[]> {
  const rows = await call<{ receipt_no: string; trip_id: string; basis: Basis; final_cents: number; tax_cents: number; platform_fee_cents: number; driver_payout_cents: number; credits_cents: number; finalized_at: number }[]>('list_my_earnings', { limit: 100 })
  return rows.map((r) => ({ receiptNo: r.receipt_no, tripId: r.trip_id, basis: r.basis, finalCents: r.final_cents, taxCents: r.tax_cents, platformFeeCents: r.platform_fee_cents, payoutCents: r.driver_payout_cents, creditsCents: r.credits_cents, finalizedAt: r.finalized_at }))
}

export const money = (cents: number, currency = 'USD') => (currency === 'USD' ? `$${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${currency}`)

export const BASIS_LABEL: Record<Basis, string> = {
  fare: 'Fare',
  cancellation_fee: 'Cancellation fee',
  no_show_fee: 'No-show fee',
  none: 'No charge',
}
