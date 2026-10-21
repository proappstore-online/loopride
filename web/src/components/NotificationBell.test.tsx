import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { hook } = vi.hoisted(() => ({ hook: { items: [] as unknown[], unread: 0, locale: 'en', markRead: vi.fn(async () => undefined) } }))
vi.mock('../lib/useNotifications', () => ({
  useNotifications: () => ({ items: hook.items, prefs: { locale: hook.locale, push: true, emailFallback: false, emailConsentAt: null }, unread: hook.unread, markRead: hook.markRead, refresh: vi.fn() }),
}))

import NotificationBell from './NotificationBell'
import { renderWithRouter } from '../../test/router'

const item = (id: string, link: string, extra = {}) => ({ id, kind: 'driver_arrived', role: 'rider', tripId: 't', requestId: 'r', link, params: {}, critical: true, createdAt: 1, readAt: null, ...extra })
const mount = () => {
  const wrap = renderWithRouter(<NotificationBell signedIn />)
  render(wrap.ui)
  return wrap
}

beforeEach(() => {
  hook.items = []
  hook.unread = 0
  hook.locale = 'en'
  hook.markRead.mockClear()
})

describe('NotificationBell', () => {
  it('renders nothing when signed out', () => {
    const { container } = render(renderWithRouter(<NotificationBell signedIn={false} />).ui)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the unread count on the bell', () => {
    hook.unread = 3
    mount()
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument()
  })

  it('says when there is nothing yet', async () => {
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('No notifications yet.')).toBeInTheDocument()
  })

  it('opens the trip a notification is about, marks it read, and closes', async () => {
    hook.items = [item('a', '/trip/r1')]
    hook.unread = 1
    const wrap = mount()
    await userEvent.click(screen.getByRole('button', { name: /Notifications/ }))
    await userEvent.click(screen.getByRole('button', { name: /Your driver has arrived/ }))
    expect(wrap.location()).toBe('/trip/r1')
    expect(hook.markRead).toHaveBeenCalledWith('a')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('links a driver notification to the driver\'s own view of the trip', async () => {
    hook.items = [item('b', '/driver/trip/rider-1/r1', { role: 'driver', kind: 'trip_cancelled', params: { by: 'rider', reason: 'wrong_pickup', fee_cents: 0 } })]
    const wrap = mount()
    await userEvent.click(screen.getByRole('button', { name: /Notifications/ }))
    await userEvent.click(screen.getByRole('button', { name: /Trip cancelled/ }))
    expect(wrap.location()).toBe('/driver/trip/rider-1/r1')
  })

  it('renders in the user\'s language', async () => {
    hook.locale = 'es'
    hook.items = [item('a', '/trip/r1')]
    mount()
    await userEvent.click(screen.getByRole('button', { name: /Notifications/ }))
    expect(screen.getByText('Tu conductor llegó')).toBeInTheDocument()
  })

  it('marks everything read in one go', async () => {
    hook.items = [item('a', '/trip/r1'), item('b', '/trip/r2')]
    hook.unread = 2
    mount()
    await userEvent.click(screen.getByRole('button', { name: /Notifications/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(hook.markRead).toHaveBeenCalledWith()
  })

  it('dims read items and hides "mark all" when none are unread', async () => {
    hook.items = [item('a', '/trip/r1', { readAt: 5 })]
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument()
  })
})
