import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RoleToggle from './RoleToggle'
import { getRole } from '../lib/mode'

describe('RoleToggle', () => {
  it('renders Rider and Driver options', () => {
    render(<RoleToggle role="rider" onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Rider' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Driver' })).toBeInTheDocument()
  })

  it('navigates to driver-home and persists role when clicking Driver', async () => {
    const onNavigate = vi.fn()
    render(<RoleToggle role="rider" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('button', { name: 'Driver' }))
    expect(onNavigate).toHaveBeenCalledWith({ name: 'driver-home' })
    expect(getRole()).toBe('driver')
  })

  it('does nothing when clicking the active role', async () => {
    const onNavigate = vi.fn()
    render(<RoleToggle role="rider" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('button', { name: 'Rider' }))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('switches from driver back to rider', async () => {
    const onNavigate = vi.fn()
    render(<RoleToggle role="driver" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('button', { name: 'Rider' }))
    expect(onNavigate).toHaveBeenCalledWith({ name: 'home' })
    expect(getRole()).toBe('rider')
  })
})
