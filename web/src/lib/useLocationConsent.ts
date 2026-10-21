import { useCallback, useEffect, useState } from 'react'
import { isCurrent, loadConsents, setLocationConsent, type LocationPurpose } from './privacy'

export type ConsentState = 'loading' | 'granted' | 'not_granted'

/** The signed-in user's consent for one purpose. Anything unknown, including a failed read, counts as not granted. */
export function useLocationConsent(purpose: LocationPurpose, enabled = true) {
  const [state, setState] = useState<ConsentState>('loading')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let live = true
    loadConsents().then(
      (all) => live && setState(isCurrent(all[purpose]) ? 'granted' : 'not_granted'),
      () => live && setState('not_granted'),
    )
    return () => {
      live = false
    }
  }, [purpose, enabled])

  const set = useCallback(
    async (granted: boolean) => {
      setFailed(false)
      try {
        await setLocationConsent(purpose, granted)
        const all = await loadConsents()
        setState(isCurrent(all[purpose]) ? 'granted' : 'not_granted')
        return true
      } catch {
        setFailed(true)
        return false
      }
    },
    [purpose],
  )

  return { state, failed, grant: () => set(true), withdraw: () => set(false) }
}
