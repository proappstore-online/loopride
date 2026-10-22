// A local stand-in for the PAS actions API, backed by the committed migrations.json and mcp.json run on
// real SQLite. It lets the journey matrix be developed and checked without touching the live app:
//
//   node fake-pas.mjs &            # listens on :8787
//   E2E_API_BASE=http://localhost:8787 E2E_RIDER_TOKEN=rider E2E_DRIVER_TOKEN=drv1 \
//     E2E_DRIVER2_TOKEN=drv2 E2E_OPS_TOKEN=ops npx playwright test matrix.spec.ts
//
// The token is the user id. It enforces the SQL of every action (so the same rules as live) but not
// the platform's role gate, and the clock is real. It is a development aid, not a replacement for the live run.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const root = new URL('../', import.meta.url)
const migrations = JSON.parse(readFileSync(new URL('migrations.json', root), 'utf8')).migrations
const tools = new Map(JSON.parse(readFileSync(new URL('mcp.json', root), 'utf8')).tools.map((t) => [t.name, t]))
const db = new DatabaseSync(':memory:')
for (const m of migrations) db.exec(m.sql)

const placeholders = (sql) => [...sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1])

function run(tool, params, userId) {
  const bound = { __user_id: userId, __now: Date.now(), __uuid: randomUUID() }
  for (const [key, spec] of Object.entries(tool.params ?? {})) {
    const v = params[key]
    if (v === undefined || v === null) {
      if ('default' in spec) bound[key] = spec.default
      else if (spec.optional) bound[key] = null
      else throw Object.assign(new Error(`missing parameter ${key}`), { status: 400 })
    } else bound[key] = v
  }
  const bind = (sql) => Object.fromEntries(placeholders(sql).map((p) => [p, bound[p]]))
  if (tool.operation === 'query') return db.prepare(tool.sql).all(bind(tool.sql))
  const statements = tool.statements ?? [tool.sql]
  db.exec('BEGIN')
  try {
    for (const sql of statements) db.prepare(sql).run(bind(sql))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { ok: true }
}

const server = createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const user = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  if (!user) return send(401, { error: 'unauthorized' })
  if (req.url === '/v1/auth/me') return send(200, { id: user, login: user })
  const match = /^\/v1\/apps\/[^/]+\/actions\/([a-z_0-9]+)$/.exec(req.url ?? '')
  if (!match || req.method !== 'POST') return send(404, { error: 'not found' })
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const tool = tools.get(match[1])
    if (!tool) return send(404, { error: 'unknown action' })
    try {
      send(200, run(tool, JSON.parse(raw || '{}').params ?? {}, user))
    } catch (e) {
      send(e.status ?? 500, { error: String(e.message) })
    }
  })
})
server.listen(Number(process.env.PORT ?? 8787), () => console.log(`fake PAS actions API on :${process.env.PORT ?? 8787}`))
