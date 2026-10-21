import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { api, toast } = vi.hoisted(() => ({ api: { loadPrefs: vi.fn(), savePrefs: vi.fn(), enablePush: vi.fn() }, toast: vi.fn() }))
vi.mock('../lib/notifications', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/notifications')>()), ...api }))
vi.mock('../lib/toast', () => ({ showToast: toast }))

import NotificationSettings from './NotificationSettings'

const prefs = (extra = {}) => ({ locale: 'en', push: true, emailFallback: false, emailConsentAt: null, ...extra })

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  toast.mockReset()
  api.loadPrefs.mockResolvedValue(prefs())
  api.savePrefs.mockResolvedValue(undefined)
  api.enablePush.mockResolvedValue(true)
})

describe('NotificationSettings', () => {
  it('starts with email off and says exactly what turning it on means', async () => {
    render(<NotificationSettings />)
    const email = await screen.findByRole('checkbox', { name: /Email me about important trip events/ })
    expect(email).not.toBeChecked()
    expect(screen.getByText(/only when a push notification could not be delivered/)).toBeInTheDocument()
    expect(screen.getByText(/one-click unsubscribe/)).toBeInTheDocument()
    expect(screen.getByText('Text messages are not available.')).toBeInTheDocument()
  })

  it('saves explicit consent and shows when it was given', async () => {
    render(<NotificationSettings />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /Email me about important trip events/ }))
    await waitFor(() => expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ emailFallback: true, push: true })))
    expect(await screen.findByText(/You agreed on/)).toBeInTheDocument()
  })

  it('withdraws consent', async () => {
    api.loadPrefs.mockResolvedValue(prefs({ emailFallback: true, emailConsentAt: 1_700_000_000_000 }))
    render(<NotificationSettings />)
    const email = await screen.findByRole('checkbox', { name: /Email me about important trip events/ })
    expect(email).toBeChecked()
    await userEvent.click(email)
    await waitFor(() => expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ emailFallback: false })))
    await waitFor(() => expect(screen.queryByText(/You agreed on/)).not.toBeInTheDocument())
  })

  it('asks the browser for permission when push is turned on, and explains when it is blocked', async () => {
    api.loadPrefs.mockResolvedValue(prefs({ push: false }))
    api.enablePush.mockResolvedValue(false)
    render(<NotificationSettings />)
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Push notifications for trip updates' }))
    await waitFor(() => expect(api.enablePush).toHaveBeenCalled())
    expect(toast).toHaveBeenCalledWith({ message: expect.stringContaining('blocked in this browser') })
    expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ push: true })) // still saved: in-app notifications work
  })

  it('does not ask for permission when turning push off', async () => {
    render(<NotificationSettings />)
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Push notifications for trip updates' }))
    await waitFor(() => expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ push: false })))
    expect(api.enablePush).not.toHaveBeenCalled()
  })

  it('saves the language', async () => {
    render(<NotificationSettings />)
    await userEvent.selectOptions(await screen.findByLabelText('Language'), 'es')
    await waitFor(() => expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ locale: 'es' })))
  })

  it('tells the user when saving fails', async () => {
    api.savePrefs.mockRejectedValue(new Error('x'))
    render(<NotificationSettings />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /Email me/ }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: "Couldn't save your notification settings" }))
  })
})
