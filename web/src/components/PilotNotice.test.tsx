import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import PilotNotice from './PilotNotice'
import { PILOT_NOTICE } from '../lib/launch'
import { expectNoA11yViolations } from '../../test/axe'

describe('PilotNotice', () => {
  it('states that the service is a pilot and takes no payment', async () => {
    const { container } = render(<PilotNotice />)
    const note = screen.getByRole('complementary', { name: 'Pilot notice' })
    expect(note).toHaveTextContent(PILOT_NOTICE.title)
    expect(note).toHaveTextContent(/limited pilot/)
    expect(note).toHaveTextContent(/no payment is taken/)
    await expectNoA11yViolations(container)
  })
})
