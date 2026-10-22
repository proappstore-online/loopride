// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import mcpFile from '../../mcp.json'

// The runbooks and the retry/idempotency matrix are part of the product's reliability. These
// checks stop them drifting from the code: a new alert, runbook link or write action that is not
// documented fails the build.
const DOCS = join(__dirname, '..', '..', 'docs')
const read = (path: string) => readFileSync(join(DOCS, path), 'utf8')
const tools = mcpFile.tools as unknown as { name: string; operation: string; sql?: string }[]

describe('runbooks', () => {
  const alertsSql = tools.find((t) => t.name === 'ops_health_alerts')!.sql!
  const codes = [...alertsSql.matchAll(/SELECT '([a-z_]+)' AS code/g)].map((m) => m[1])
  const runbooks = [...new Set([...alertsSql.matchAll(/'((?:dispatch|map|notification)-outage|rollback|safety-incident)' AS runbook/g)].map((m) => m[1]))]
  const readme = read('runbooks/README.md')

  it('every alert the console can fire is documented with its threshold', () => {
    expect(codes.length).toBeGreaterThanOrEqual(15)
    for (const code of codes.filter((c) => !c.endsWith('_error_rate'))) expect(readme, code).toContain(`\`${code}\``)
    expect(readme).toContain('`<domain>_error_rate`')
  })

  it('every runbook an alert points to exists, and the ones the issues ask for are present', () => {
    for (const name of runbooks) expect(existsSync(join(DOCS, 'runbooks', `${name}.md`)), name).toBe(true)
    for (const name of ['dispatch-outage', 'map-outage', 'notification-outage', 'rollback']) expect(existsSync(join(DOCS, 'runbooks', `${name}.md`)), name).toBe(true)
    expect(runbooks.sort()).toEqual(['dispatch-outage', 'map-outage', 'notification-outage', 'rollback', 'safety-incident'])
  })

  it('every link between the documents resolves', () => {
    for (const file of ['runbooks/README.md', 'runbooks/dispatch-outage.md', 'runbooks/map-outage.md', 'runbooks/notification-outage.md', 'runbooks/rollback.md', 'runbooks/safety-incident.md', 'safety.md', 'reliability.md']) {
      const base = join(DOCS, file, '..')
      for (const m of read(file).matchAll(/\]\(((?!https?:|#)[^)#]+)(?:#[^)]*)?\)/g)) expect(existsSync(join(base, m[1])), `${file} -> ${m[1]}`).toBe(true)
    }
  })

  it('each runbook says how to contain, recover and confirm', () => {
    for (const name of ['dispatch-outage', 'map-outage', 'notification-outage', 'rollback', 'safety-incident']) {
      const text = read(`runbooks/${name}.md`)
      expect(text, name).toMatch(/Recover|After any rollback|Resolve/)
      expect(text, name).toMatch(/Pause|pause|revert|Nothing to repair|Contain/)
    }
  })

  it('the dispatch switch the runbooks rely on exists and is role-gated', () => {
    expect(tools.find((t) => t.name === 'ops_set_service_flag')).toMatchObject({ auth: { app_roles: ['ops'] } })
    expect(read('runbooks/dispatch-outage.md')).toContain('Pause dispatch')
  })
})

describe('retry and idempotency matrix', () => {
  const doc = read('reliability.md')

  it('names every action that changes data', () => {
    const writers = tools.filter((t) => t.operation !== 'query').map((t) => t.name)
    expect(writers.length).toBeGreaterThan(40)
    const missing = writers.filter((name) => !doc.includes(`\`${name}\``) && !doc.includes(name))
    expect(missing).toEqual([])
  })

  it('covers every kind of external call the app makes', () => {
    for (const topic of ['Geocoding', 'Routing', 'Web push', 'Email fallback', 'Browser geolocation', 'Platform auth', 'Tool registration', 'Telemetry']) expect(doc, topic).toContain(topic)
    expect(doc).toMatch(/No payment is collected/)
  })
})

describe('the outside probe', () => {
  const workflow = readFileSync(join(DOCS, '..', '.github', 'workflows', 'health-check.yml'), 'utf8')

  it('runs on a schedule and checks the site, the platform and the registered tools', () => {
    expect(workflow).toMatch(/cron: '\*\/15 \* \* \* \*'/)
    expect(workflow).toContain('loopride.proappstore.online')
    expect(workflow).toContain('api.proappstore.online/health')
    expect(workflow).toContain('/v1/apps/loopride/tools')
    expect(workflow).toContain('mcp.json')
  })
})

describe('safety documentation (issue #12)', () => {
  const safety = read('safety.md')
  const runbook = read('runbooks/safety-incident.md')

  it('defines the escalation target, the blocking policy and the jurisdictional limits', () => {
    expect(safety).toMatch(/within 5 minutes/)
    expect(safety).toContain('ops_suspend_driver')
    expect(safety).toContain('ops_block_rider')
    expect(safety).toContain('## Needs a human decision')
    expect(safety).toMatch(/not an emergency service/)
    expect(safety).toMatch(/nothing pages\s+anyone/)
  })

  it('the escalation target is the one the alert measures', () => {
    const sql = tools.find((t) => t.name === 'ops_health_alerts')!.sql!
    expect(sql).toContain("r.created_at <= :__now - 300000")
    expect(read('runbooks/README.md')).toContain('`safety_unacknowledged`')
  })

  it('the runbook puts emergency services before the console and names the audited actions', () => {
    expect(runbook.indexOf('emergency services')).toBeLessThan(runbook.indexOf('## 1.'))
    for (const word of ['Acknowledge', 'Cancel trip', 'Suspend driver', 'Block rider', 'Resolve']) expect(runbook).toContain(word)
  })

  it('the emergency copy the screens show is the copy the policy quotes', () => {
    const copy = readFileSync(join(DOCS, '..', 'web', 'src', 'lib', 'safety.ts'), 'utf8')
    for (const line of ['If you are in immediate danger, contact your local emergency services now. Do not wait for a reply from us.', 'LoopRide is not an emergency service. We cannot call emergency services for you, send help to your location or tell you how quickly staff will see a report.'])
      expect(copy).toContain(line)
    expect(safety.replace(/\n> ?/g, ' ').replace(/\s+/g, ' ')).toContain('If you are in immediate danger, contact your local emergency services now. Do not wait for a reply from us.')
  })
})

describe('accessibility documentation and mobile guards (issue #14)', () => {
  const doc = read('accessibility.md')
  const root = join(DOCS, '..')
  const css = readFileSync(join(root, 'web', 'src', 'index.css'), 'utf8')
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  const workflow = readFileSync(join(root, '.github', 'workflows', 'test.yml'), 'utf8')

  it('has a manual mobile checklist covering request, tracking, cancellation and driver acceptance', () => {
    expect(doc).toContain('## Manual mobile checklist')
    expect(doc.match(/- \[ \]/g)!.length).toBeGreaterThanOrEqual(20)
    for (const topic of ['### Request a ride', '### Track and cancel', '### Driver', 'VoiceOver', 'TalkBack', '200%']) expect(doc, topic).toContain(topic)
  })

  it('the automated checks it describes are in CI', () => {
    expect(workflow).toContain('pnpm test')
    expect(workflow).toContain('pnpm test:e2e')
    expect(existsSync(join(root, 'web', 'e2e', 'accessibility.spec.ts'))).toBe(true)
    expect(existsSync(join(root, 'web', 'test', 'axe.ts'))).toBe(true)
  })

  it('never turns off pinch zoom', () => {
    const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)![1]
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/)
    expect(viewport).not.toMatch(/maximum-scale/)
    expect(viewport).toContain('width=device-width')
  })

  it('keeps the 44 px touch target, focus ring, skip link and reduced-motion rules', () => {
    expect(css).toMatch(/button[^{]*\{ min-height: 44px; \}/)
    expect(css).toContain(':focus-visible')
    expect(css).toContain('.skip-link')
    expect(css).toContain('prefers-reduced-motion')
  })
})
