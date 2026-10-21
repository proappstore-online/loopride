import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import ReceiptCard from './ReceiptCard'
import type { Receipt } from '../lib/receipts'

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({ receiptNo: 'RCT-ab12cd34', tripId: 't', requestId: 'r', basis: 'fare', currency: 'USD', quotedCents: 1150, baseCents: 200, distanceCents: 550, timeCents: 250, bookingFeeCents: 150, minAdjustCents: 0, surgeMilli: 1000, finalCents: 1150, taxRateBp: 0, taxCents: 0, creditsCents: 0, totalCents: 1150, pickup: 'Central', dropoff: 'Airport', finalizedAt: Date.UTC(2026, 5, 1), ...extra })

describe('ReceiptCard', () => {
  it('itemises a fare from the accepted quote', () => {
    render(<ReceiptCard receipt={receipt()} />)
    expect(screen.getByText('Central → Airport')).toBeInTheDocument()
    expect(screen.getByText('RCT-ab12cd34', { exact: false })).toBeInTheDocument()
    for (const label of ['Base fare', 'Distance', 'Time', 'Booking fee']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getAllByText('$11.50')).toHaveLength(2) // fare line and total
    expect(screen.queryByText('High demand')).not.toBeInTheDocument()
    expect(screen.queryByText(/Credits/)).not.toBeInTheDocument()
  })

  it('shows surge, minimum fare adjustment, tax and credits when they apply', () => {
    render(<ReceiptCard receipt={receipt({ surgeMilli: 1500, minAdjustCents: 100, taxRateBp: 1000, taxCents: 105, creditsCents: 200, totalCents: 950 })} />)
    expect(screen.getByText('1.5×')).toBeInTheDocument()
    expect(screen.getByText('Minimum fare adjustment')).toBeInTheDocument()
    expect(screen.getByText('Includes tax (10.00%)')).toBeInTheDocument()
    expect(screen.getByText('−$2.00')).toBeInTheDocument()
    expect(screen.getByText('$9.50')).toBeInTheDocument()
  })

  it('shows a cancellation fee without fare components', () => {
    render(<ReceiptCard receipt={receipt({ basis: 'cancellation_fee', baseCents: null, distanceCents: null, timeCents: null, bookingFeeCents: null, surgeMilli: null, finalCents: 500, totalCents: 500 })} />)
    expect(screen.getByText('Cancellation fee')).toBeInTheDocument()
    expect(screen.queryByText('Base fare')).not.toBeInTheDocument()
  })

  it('shows a zero total for a free cancellation', () => {
    render(<ReceiptCard receipt={receipt({ basis: 'none', finalCents: 0, totalCents: 0, baseCents: null })} />)
    expect(screen.getByText('No charge')).toBeInTheDocument()
  })

  it('is honest that nothing was paid in the app and that receipts never change', () => {
    render(<ReceiptCard receipt={receipt()} />)
    expect(screen.getByText(/Payment is not collected in the app yet/)).toBeInTheDocument()
    expect(screen.getByText(/never changes after the trip/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument() // no card or credential fields
  })
})
