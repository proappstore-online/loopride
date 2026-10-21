import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { tel } = vi.hoisted(() => ({ tel: { reportError: vi.fn() } }))
vi.mock('../lib/telemetry', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/telemetry')>()), reportError: tel.reportError }))

import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('render exploded')
}

beforeEach(() => {
  tel.reportError.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('ErrorBoundary', () => {
  it('reports a crash as a structured error and shows the fallback', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(tel.reportError).toHaveBeenCalledWith({ domain: 'request', code: 'render_crash', severity: 'error', error: expect.objectContaining({ message: 'render exploded' }) })
  })

  it('reports nothing when nothing crashes', () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>)
    expect(tel.reportError).not.toHaveBeenCalled()
  })
})
