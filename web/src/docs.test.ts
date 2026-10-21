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
  const runbooks = [...new Set([...alertsSql.matchAll(/'((?:dispatch|map|notification)-outage|rollback)' AS runbook/g)].map((m) => m[1]))]
  const readme = read('runbooks/README.md')

  it('every alert the console can fire is documented with its threshold', () => {
    expect(codes.length).toBeGreaterThanOrEqual(15)
    for (const code of codes.filter((c) => !c.endsWith('_error_rate'))) expect(readme, code).toContain(`\`${code}\``)
    expect(readme).toContain('`<domain>_error_rate`')
  })

  it('every runbook an alert points to exists, and the four the issue asks for are present', () => {
    for (const name of runbooks) expect(existsSync(join(DOCS, 'runbooks', `${name}.md`)), name).toBe(true)
    for (const name of ['dispatch-outage', 'map-outage', 'notification-outage', 'rollback']) expect(existsSync(join(DOCS, 'runbooks', `${name}.md`)), name).toBe(true)
    expect(runbooks.sort()).toEqual(['dispatch-outage', 'map-outage', 'notification-outage', 'rollback'])
  })

  it('every link between the documents resolves', () => {
    for (const file of ['runbooks/README.md', 'runbooks/dispatch-outage.md', 'runbooks/map-outage.md', 'runbooks/notification-outage.md', 'runbooks/rollback.md', 'reliability.md']) {
      const base = join(DOCS, file, '..')
      for (const m of read(file).matchAll(/\]\(((?!https?:|#)[^)#]+)(?:#[^)]*)?\)/g)) expect(existsSync(join(base, m[1])), `${file} -> ${m[1]}`).toBe(true)
    }
  })

  it('each runbook says how to contain, recover and confirm', () => {
    for (const name of ['dispatch-outage', 'map-outage', 'notification-outage', 'rollback']) {
      const text = read(`runbooks/${name}.md`)
      expect(text, name).toMatch(/Recover|After any rollback/)
      expect(text, name).toMatch(/Pause|pause|revert|Nothing to repair/)
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
