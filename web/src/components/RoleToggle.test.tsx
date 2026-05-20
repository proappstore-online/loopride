import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RoleToggle from './RoleToggle'
import { getRole } from '../lib/mode'
import { renderWithRouter } from '../../test/router'

function mount(role: 'rider' | 'driver', initialPath = '/') {
  const wrap = renderWithRouter(<RoleToggle role={role} />, initialPath)
  render(wrap.ui)
  return wrap
}

describe('RoleToggle', () => {
  it('renders Rider and Driver options', () => {
    mount('rider')
    expect(screen.getByRole('button', { name: 'Rider' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Driver' })).toBeInTheDocument()
  })

  it('navigates to /driver and persists role when clicking Driver', async () => {
    const wrap = mount('rider')
    await userEvent.click(screen.getByRole('button', { name: 'Driver' }))
    expect(wrap.location()).toBe('/driver')
    expect(getRole()).toBe('driver')
  })

  it('does nothing when clicking the active role', async () => {
    const wrap = mount('rider')
    await userEvent.click(screen.getByRole('button', { name: 'Rider' }))
    expect(wrap.history).toEqual(['/'])
  })

  it('switches from driver back to rider', async () => {
    const wrap = mount('driver', '/driver')
    await userEvent.click(screen.getByRole('button', { name: 'Rider' }))
    expect(wrap.location()).toBe('/')
    expect(getRole()).toBe('rider')
  })
})
