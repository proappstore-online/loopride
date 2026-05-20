import { type ReactNode } from 'react'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'

/**
 * Render helper for tests: wraps children in a wouter Router backed by an
 * in-memory location. Returns the navigate helper + a `location()` getter
 * so tests can assert on the current path after interactions.
 */
export function renderWithRouter(children: ReactNode, initialPath = '/') {
  const { hook, history, navigate } = memoryLocation({ path: initialPath, record: true })
  return {
    ui: <Router hook={hook}>{children}</Router>,
    history,
    navigate,
    location: () => history[history.length - 1] ?? initialPath,
  }
}
