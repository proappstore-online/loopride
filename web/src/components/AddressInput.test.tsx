import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

const { geocode } = vi.hoisted(() => ({ geocode: vi.fn() }))
vi.mock('../lib/maps', () => ({ geocode }))

import AddressInput from './AddressInput'
import { expectNoA11yViolations } from '../../test/axe'

const results = [
  { lat: -33.88, lng: 151.2, displayName: '12, George Street, Sydney, Australia' },
  { lat: -33.87, lng: 151.21, displayName: 'Central Station, Sydney, Australia' },
]

function Harness({ onPick }: { onPick: (name: string, lat: number) => void }) {
  const [value, setValue] = useState('')
  return <AddressInput label="Pickup" value={value} onChange={setValue} onSelect={(name, c) => { setValue(name); onPick(name, c.lat) }} placeholder="Enter pickup" maxLength={80} testIdPrefix="pickup" />
}

beforeEach(() => {
  geocode.mockReset()
  geocode.mockResolvedValue(results)
})

describe('AddressInput (combobox)', () => {
  it('is a labelled combobox that starts collapsed', () => {
    render(<Harness onPick={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Pickup' })
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shows suggestions, announces how many, and passes axe', async () => {
    const { container } = render(<Harness onPick={vi.fn()} />)
    await userEvent.type(screen.getByRole('combobox'), 'Geo')
    expect(await screen.findByRole('listbox', { name: 'Pickup suggestions' })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('status').some((s) => /2 suggestions available/.test(s.textContent ?? ''))).toBe(true)
    await expectNoA11yViolations(container)
  })

  it('moves through suggestions with the arrow keys, chooses with Enter and keeps focus in the field', async () => {
    const pick = vi.fn()
    render(<Harness onPick={pick} />)
    const input = screen.getByRole('combobox')
    await userEvent.type(input, 'Geo')
    await screen.findAllByRole('option')
    await userEvent.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id)
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true') // wraps round
    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Enter}')
    expect(pick).toHaveBeenCalledWith('Central Station', -33.87)
    expect(input).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('Enter without a highlighted suggestion does nothing, and Escape closes the list', async () => {
    const pick = vi.fn()
    render(<Harness onPick={pick} />)
    const input = screen.getByRole('combobox')
    await userEvent.type(input, 'Geo')
    await screen.findAllByRole('option')
    await userEvent.keyboard('{Enter}')
    expect(pick).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    await userEvent.keyboard('{ArrowDown}')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
  })

  it('still works with a pointer, and suggestions are at least 44px tall by class', async () => {
    const pick = vi.fn()
    render(<Harness onPick={pick} />)
    await userEvent.type(screen.getByRole('combobox'), 'Geo')
    const [first] = await screen.findAllByRole('option')
    expect(first.className).toContain('min-h-11')
    await userEvent.click(first)
    expect(pick).toHaveBeenCalledWith('12 George Street', -33.88)
  })

  it('shows nothing, and announces nothing, when the lookup fails', async () => {
    geocode.mockRejectedValue(new Error('down'))
    render(<Harness onPick={vi.fn()} />)
    await userEvent.type(screen.getByRole('combobox'), 'Geo')
    await waitFor(() => expect(geocode).toHaveBeenCalled())
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
