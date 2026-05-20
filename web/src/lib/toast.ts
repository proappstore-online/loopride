import { useEffect, useState } from 'react'

export interface Toast {
  id: string
  message: string
  action?: { label: string; onClick: () => void }
  /** ms before auto-dismiss. 0 disables. */
  duration?: number
}

const listeners = new Set<(toasts: Toast[]) => void>()
let toasts: Toast[] = []

function emit(): void {
  for (const l of listeners) l(toasts)
}

export function showToast(t: Omit<Toast, 'id'>): string {
  const id = crypto.randomUUID()
  const toast: Toast = { id, duration: 5000, ...t }
  toasts = [...toasts, toast]
  emit()
  if (toast.duration && toast.duration > 0) {
    setTimeout(() => dismissToast(id), toast.duration)
  }
  return id
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function useToasts(): Toast[] {
  const [snapshot, setSnapshot] = useState<Toast[]>(toasts)
  useEffect(() => {
    listeners.add(setSnapshot)
    setSnapshot(toasts)
    return () => {
      listeners.delete(setSnapshot)
    }
  }, [])
  return snapshot
}
