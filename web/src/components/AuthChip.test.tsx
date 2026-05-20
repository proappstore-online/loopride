import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { User } from '@proappstore/sdk/hooks'
import AuthChip from './AuthChip'

const user: User = {
  id: 'u1',
  login: 'sergey',
  avatarUrl: null,
} as User

describe('AuthChip', () => {
  it('shows ellipsis while loading', () => {
    render(<AuthChip loading user={null} onSignIn={vi.fn()} onSignOut={vi.fn()} />)
    expect(screen.getByText('…')).toBeInTheDocument()
  })

  it('renders Google + GitHub buttons when signed out', () => {
    render(<AuthChip loading={false} user={null} onSignIn={vi.fn()} onSignOut={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument()
  })

  it('clicking Google fires onSignIn("google")', async () => {
    const onSignIn = vi.fn()
    render(<AuthChip loading={false} user={null} onSignIn={onSignIn} onSignOut={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))
    expect(onSignIn).toHaveBeenCalledWith('google')
  })

  it('clicking GitHub fires onSignIn("github")', async () => {
    const onSignIn = vi.fn()
    render(<AuthChip loading={false} user={null} onSignIn={onSignIn} onSignOut={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }))
    expect(onSignIn).toHaveBeenCalledWith('github')
  })

  it('shows user handle + Sign out when signed in', async () => {
    const onSignOut = vi.fn()
    render(<AuthChip loading={false} user={user} onSignIn={vi.fn()} onSignOut={onSignOut} />)
    expect(screen.getByText('@sergey')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalled()
  })
})
