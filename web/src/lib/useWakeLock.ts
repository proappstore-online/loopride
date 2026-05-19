import { useEffect, useState } from 'react'

type WakeLockSentinel = {
  release: () => Promise<void>
  addEventListener: (type: 'release', cb: () => void) => void
}

interface NavigatorWithWakeLock {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> }
}

export interface WakeLockState {
  supported: boolean
  active: boolean
  error: string | null
}

export function useWakeLock(enabled: boolean): WakeLockState {
  const wakeLockNav = (navigator as unknown as NavigatorWithWakeLock).wakeLock
  const supported = typeof wakeLockNav?.request === 'function'
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !supported) {
      setActive(false)
      return
    }

    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async () => {
      try {
        sentinel = (await wakeLockNav!.request('screen')) as WakeLockSentinel
        if (cancelled) {
          await sentinel.release()
          sentinel = null
          return
        }
        sentinel.addEventListener('release', () => setActive(false))
        setActive(true)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setActive(false)
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel) {
        void acquire()
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (sentinel) void sentinel.release().catch(() => undefined)
      sentinel = null
      setActive(false)
    }
  }, [enabled, supported, wakeLockNav])

  return { supported, active, error }
}
