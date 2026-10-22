// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LAUNCH_STAGE, PILOT_NOTICE } from './launch'

// Issue #18. The launch register is data, and the rules about it are tests: a gate cannot be approved
// without an owner, evidence, a different approver and a date, and the product cannot leave pilot while a
// critical gate is open.
const DOCS = join(__dirname, '..', '..', '..', 'docs')
interface Gate {
  id: string; title: string; area: string; critical: boolean; why: string; evidenceRequired: string; builtInRepo: string; dependsOn: string[]
  status: string; owner: string | null; evidence: string[]; approvedBy: string | null; approvedOn: string | null
}
const register = JSON.parse(readFileSync(join(DOCS, 'launch-gates.json'), 'utf8')) as { statuses: string[]; gates: Gate[] }
const gates = register.gates
const page = readFileSync(join(DOCS, 'launch.md'), 'utf8')

describe('launch gates register', () => {
  it('covers insurance, local transport rules, driver screening, taxes, terms, privacy and support', () => {
    const areas = gates.map((g) => g.area)
    for (const a of ['insurance', 'local_transport_rules', 'driver_screening', 'taxes', 'terms', 'privacy', 'support_coverage']) expect(areas, a).toContain(a)
    for (const a of ['payments', 'safety', 'operations', 'reliability', 'communications']) expect(areas, a).toContain(a)
  })

  it('has unique ids and says why each gate exists and what evidence proves it', () => {
    expect(new Set(gates.map((g) => g.id)).size).toBe(gates.length)
    for (const g of gates) {
      expect(g.why.length, g.id).toBeGreaterThan(30)
      expect(g.evidenceRequired.length, g.id).toBeGreaterThan(30)
      expect(g.builtInRepo.length, g.id).toBeGreaterThan(5)
      expect(register.statuses, g.id).toContain(g.status)
    }
  })

  it('an approved gate has an owner, evidence, a different approver and a date; others have not been approved by anyone', () => {
    for (const g of gates) {
      if (g.status === 'approved') {
        expect(g.owner, `${g.id} owner`).toBeTruthy()
        expect(g.evidence.length, `${g.id} evidence`).toBeGreaterThan(0)
        for (const e of g.evidence) expect(e.trim().length, `${g.id} evidence item`).toBeGreaterThan(5)
        expect(g.approvedBy, `${g.id} approver`).toBeTruthy()
        expect(g.approvedBy, `${g.id} approver must not be the owner`).not.toBe(g.owner)
        expect(g.approvedOn, `${g.id} date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      } else {
        expect(g.approvedBy, `${g.id} approver`).toBeNull()
        expect(g.approvedOn, `${g.id} date`).toBeNull()
      }
      if (g.status === 'ready_for_approval' || g.status === 'in_progress') expect(g.owner, `${g.id} owner`).toBeTruthy()
    }
  })

  it('every critical gate that depends on another issue names it', () => {
    for (const g of gates) for (const d of g.dependsOn) expect(d, g.id).toMatch(/^#\d+$/)
  })
})

describe('the product is limited to a pilot until the critical gates are approved', () => {
  const open = gates.filter((g) => g.critical && g.status !== 'approved')

  it('is a pilot while any critical gate is open', () => {
    if (open.length > 0) expect(LAUNCH_STAGE, `open: ${open.map((g) => g.id).join(', ')}`).toBe('pilot')
  })

  it('may only be public when every critical gate is approved', () => {
    if (LAUNCH_STAGE === 'public') expect(open.map((g) => g.id)).toEqual([])
  })

  it('has critical gates, so the guard above is not vacuous', () => {
    expect(gates.filter((g) => g.critical).length).toBeGreaterThanOrEqual(10)
  })

  it('tells people it is a pilot and that no payment is taken, in plain words', () => {
    expect(PILOT_NOTICE.body).toMatch(/limited pilot/)
    expect(PILOT_NOTICE.body).toMatch(/no payment is taken/)
  })
})

describe('docs/launch.md', () => {
  it('lists every gate in its table and describes it', () => {
    for (const g of gates) {
      expect(page, g.id).toContain(`| \`${g.id}\` |`)
      expect(page, g.id).toContain(`### \`${g.id}\``)
      expect(page, g.id).toContain(g.evidenceRequired)
    }
  })

  it('states the pilot rule, the approval rule and that nothing is approved yet', () => {
    expect(page).toMatch(/demo or pilot/)
    expect(page).toContain('LAUNCH_STAGE')
    expect(page).toMatch(/accountable \*\*owner\*\*/)
    expect(page).toMatch(/Nothing on this page has been approved/)
  })

  it('documents rollback at three levels using mechanisms that exist, and a communication plan', () => {
    for (const heading of ['## Rollback', '## Communicating with riders and drivers', '### Who sends what', '### Draft messages']) expect(page, heading).toContain(heading)
    for (const link of ['runbooks/dispatch-outage.md', 'runbooks/rollback.md', 'safety.md', 'privacy.md']) {
      expect(page, link).toContain(link)
      expect(existsSync(join(DOCS, link)), link).toBe(true)
    }
    expect(page).toContain('Pause dispatch')
    expect(page).toContain('ops_cancel_trip')
  })

  it('does not claim a legal or insurance position', () => {
    expect(page).not.toMatch(/\b(RideShare|the service|the product|drivers?|we) (is|are) (fully )?(insured|licensed|compliant|legal)\b/i)
    expect(page).toMatch(/make no legal claim/)
  })

  it('every relative link resolves', () => {
    for (const m of page.matchAll(/\]\(((?!https?:|#)[^)#]+)(?:#[^)]*)?\)/g)) expect(existsSync(join(DOCS, m[1])), m[1]).toBe(true)
  })
})
