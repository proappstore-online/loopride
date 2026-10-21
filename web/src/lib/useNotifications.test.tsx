import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const { api, toast } = vi.hoisted(() => ({
  api: { loadInbox: vi.fn(), loadPrefs: vi.fn(), markRead: vi.fn(), deliverPending: vi.fn() },
  toast: vi.fn(),
}))
vi.mock('./notifications', async (importOriginal) => ({ ...(await importOriginal<typeof import('./notifications')>()), ...api }))
vi.mock('./toast', () => ({ showToast: toast }))

import { POLL_MS, useNotifications } from './useNotifications'

const note = (id: string, extra = {}) => ({ id, kind: 'driver_arrived', role: 'rider', tripId: 't', requestId: 'r', link: '/trip/r', params: {}, critical: true, createdAt: 1, readAt: null, ...extra })

beforeEach(() => {
  vi.useFakeTimers()
  Object.values(api).forEach((f) => f.mockReset())
  toast.mockReset()
  api.loadPrefs.mockResolvedValue({ locale: 'en', push: true, emailFallback: false, emailConsentAt: null })
  api.markRead.mockResolvedValue(undefined)
  api.deliverPending.mockResolvedValue({ sent: 0, failed: 0, skipped: 0 })
})
afterEach(() => vi.useRealTimers())

describe('useNotifications', () => {
  it('does nothing while signed out', async () => {
    renderHook(() => useNotifications(false))
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2))
    expect(api.loadInbox).not.toHaveBeenCalled()
    expect(api.deliverPending).not.toHaveBeenCalled()
  })

  it('loads the inbox, counts unread, and treats what was already there as old news', async () => {
    api.loadInbox.mockResolvedValue([note('a'), note('b', { readAt: 5 })])
    const { result } = renderHook(() => useNotifications(true))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.items).toHaveLength(2)
    expect(result.current.unread).toBe(1)
    expect(toast).not.toHaveBeenCalled()
  })

  it('pops a toast, in the user\'s language, for each new unread notification', async () => {
    api.loadInbox.mockResolvedValue([])
    api.loadPrefs.mockResolvedValue({ locale: 'es', push: true, emailFallback: false, emailConsentAt: null })
    renderHook(() => useNotifications(true))
    await act(() => vi.advanceTimersByTimeAsync(0))
    api.loadInbox.mockResolvedValue([note('new1')])
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith({ message: 'Tu conductor llegó' })
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS)) // the same one again: no second toast
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('also sends what this user owes to others on every poll, and survives a failing poll', async () => {
    api.loadInbox.mockRejectedValue(new Error('offline'))
    api.deliverPending.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useNotifications(true))
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2))
    expect(api.deliverPending).toHaveBeenCalledTimes(3)
    expect(result.current.items).toEqual([])
  })

  it('marks read and refreshes', async () => {
    api.loadInbox.mockResolvedValueOnce([note('a')]).mockResolvedValue([note('a', { readAt: 9 })])
    const { result } = renderHook(() => useNotifications(true))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.unread).toBe(1)
    await act(async () => { await result.current.markRead('a') })
    expect(api.markRead).toHaveBeenCalledWith('a')
    expect(result.current.unread).toBe(0)
  })

  it('stops polling when it unmounts', async () => {
    api.loadInbox.mockResolvedValue([])
    const { unmount } = renderHook(() => useNotifications(true))
    await act(() => vi.advanceTimersByTimeAsync(0))
    unmount()
    api.loadInbox.mockClear()
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 3))
    expect(api.loadInbox).not.toHaveBeenCalled()
  })
})
