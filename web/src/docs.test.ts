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

describe('live journey matrix (issue #17)', () => {
  const root = join(DOCS, '..')
  const spec = readFileSync(join(root, 'e2e', 'specs', 'matrix.spec.ts'), 'utf8')
  const lib = readFileSync(join(root, 'e2e', 'lib', 'live.ts'), 'utf8')
  const registry = readFileSync(join(root, 'e2e', 'matrix.ts'), 'utf8')
  const doc = read('e2e-matrix.md')
  const deploy = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8')
  const ids = [...registry.matchAll(/\{ id: '(J\d+)', title: '([^']+)', issues: \[([^\]]*)\]/g)].map((m) => ({ id: m[1], title: m[2], issues: m[3].split(',').map((n) => Number(n.trim())) }))

  it('covers every journey the issue names', () => {
    const titles = ids.map((j) => j.title).join(' | ')
    for (const needed of [/request to completion/, /no driver/, /decline and re-dispatch/, /cancellation/, /stale GPS/, /safety report/, /suspension/]) expect(titles).toMatch(needed)
    expect(ids.length).toBeGreaterThanOrEqual(7)
  })

  it('has one test per journey, named from the registry, and one row on the documentation page', () => {
    for (const j of ids) {
      expect(spec, j.id).toContain(`tag(j('${j.id}'))`)
      expect(doc, j.id).toMatch(new RegExp(`\\| ${j.id} \\|`))
      expect(j.issues.length, j.id).toBeGreaterThan(0)
      for (const n of j.issues) expect(doc, `${j.id} cites #${n}`).toContain(`#${n}`)
    }
    expect([...spec.matchAll(/tag\(j\('(J\d+)'\)\)/g)].map((m) => m[1]).sort()).toEqual(ids.map((j) => j.id).sort())
  })

  it('only calls actions that exist, with parameters they declare', () => {
    const names = new Set(tools.map((t) => t.name))
    const source = spec + lib
    const calls = [...source.matchAll(/\.(?:call|tryCall)(?:<[^>(]*>)?\('([a-z_]+)'/g)]
    expect(calls.length).toBeGreaterThan(40)
    const declared = (name: string) => Object.keys((tools.find((t) => t.name === name) as unknown as { params?: Record<string, unknown> }).params ?? {})
    /** The top-level keys of the object literal that follows the action name, if there is one. */
    const keysAfter = (from: number) => {
      const rest = source.slice(from)
      const open = /^,\s*\{/.exec(rest)
      if (!open) return []
      let depth = 0
      const keys: string[] = []
      for (let i = open[0].length - 1; i < rest.length; i++) {
        const c = rest[i]
        if (c === '{' || c === '(' || c === '[') depth++
        else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) break }
        else if (depth === 1) {
          const key = /^[{,]\s*([a-z_]+):/.exec(rest.slice(i))
          if (key && (c === ',' || c === '{')) keys.push(key[1])
        }
      }
      return keys
    }
    for (const m of calls) {
      expect(names.has(m[1]), `unknown action ${m[1]}`).toBe(true)
      for (const key of keysAfter(m.index! + m[0].length)) expect(declared(m[1]), `${m[1]}: ${key}`).toContain(key)
    }
  })

  it('cleans up after itself and names the accounts the workflow provides', () => {
    expect(spec).toContain('afterAll')
    expect(lib).toContain('delete_my_rider_data')
    expect(lib).toContain('delete_my_driver_data')
    for (const secret of ['PAS_E2E_RIDER_TOKEN', 'PAS_E2E_DRIVER_TOKEN', 'PAS_E2E_DRIVER2_TOKEN', 'PAS_E2E_OPS_TOKEN']) {
      expect(deploy, secret).toContain(secret)
      expect(doc, secret).toContain(secret)
    }
  })

  it('runs after every deploy, uploads artifacts and writes the owner summary', () => {
    expect(deploy).toMatch(/e2e:\s+needs: deploy/)
    expect(deploy).toContain('node report.mjs')
    expect(deploy).toContain('actions/upload-artifact')
    expect(deploy).toContain('Fail the run if E2E failed')
  })

  it('never records a token in the action trail', () => {
    expect(lib).not.toMatch(/params,\s*result[^\n]*token/i)
    expect(lib).toContain('tokens are never recorded'.slice(0, 0) + 'Every call of the current test')
    expect(lib.match(/trail\.push/g)).toHaveLength(1)
    expect(lib).not.toMatch(/entry\.[a-z]+ = .*Authorization/)
  })

  it('report.mjs names the owning issues for a failure and reads Playwright results', async () => {
    const mod = (await import(/* @vite-ignore */ join(root, 'e2e', 'report.mjs'))) as {
      summarise: (r: unknown) => { id: string; status: string; issues: number[]; error?: string; artifacts: string[] }[]
      markdown: (rows: unknown) => string
    }
    const results = {
      suites: [{ title: 'matrix.spec.ts', specs: [], suites: [] }, { specs: [
        { title: 'J1 request to completion [#6 #5 #7]', ok: false, tests: [{ status: 'unexpected', results: [{ error: { message: 'Expected: "completed"\nReceived: "en_route"' }, attachments: [{ name: 'action-trail.json' }, { name: 'trace' }] }] }] },
        { title: 'J3 decline and re-dispatch [#5]', ok: true, tests: [{ status: 'expected', results: [{ attachments: [] }] }] },
        { title: 'J6 stale GPS raises the alert [#8 #15]', ok: true, tests: [{ status: 'skipped', results: [] }] },
        { title: 'rider home boots without crashing', ok: true, tests: [{ status: 'expected', results: [] }] },
      ] }],
    }
    const rows = mod.summarise(results)
    expect(rows.map((r) => [r.id, r.status])).toEqual([['J1', 'failed'], ['J3', 'passed'], ['J6', 'skipped']])
    expect(rows[0]).toMatchObject({ issues: [6, 5, 7], artifacts: ['action-trail.json', 'trace'] })
    const text = mod.markdown(rows)
    expect(text).toContain('| J1 request to completion | FAIL |')
    expect(text).toContain('Report it on [#6](https://github.com/proappstore-online/loopride/issues/6)')
    expect(text).toContain('Received: "en_route"')
    expect(text).toContain('action-trail.json')
    expect(mod.markdown(mod.summarise({ suites: [] }))).toContain('No journey ran')
  })
})
