// Turns Playwright's results.json into a job summary a person can act on (issue #17): one line per
// journey with its result, and for each failure the issues that own it, the failing step and where the
// artifacts are (action-trail.json, trace, screenshot). Reads results.json; appends to
// $GITHUB_STEP_SUMMARY when set, always prints. Never fails the job: the e2e step already does.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const REPO = process.env.GITHUB_REPOSITORY || 'proappstore-online/loopride'
const RUN_URL = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
const file = process.argv[2] || 'results.json'

export function summarise(results) {
  const rows = []
  const walk = (suites = []) => suites.forEach((s) => {
    for (const spec of s.specs ?? []) {
      const m = /^(J\d+) (.+?) \[((?:#\d+ ?)+)\]$/.exec(spec.title)
      if (!m) continue
      const test = spec.tests?.[0]
      const last = test?.results?.at(-1)
      const status = test?.status === 'skipped' ? 'skipped' : spec.ok ? 'passed' : 'failed'
      rows.push({
        id: m[1], title: m[2], issues: m[3].trim().split(/\s+/).map((x) => Number(x.slice(1))), status,
        error: last?.error?.message?.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join('\n'),
        artifacts: (last?.attachments ?? []).map((a) => a.name),
        skipReason: test?.annotations?.find((a) => a.type === 'skip')?.description,
      })
    }
    walk(s.suites)
  })
  walk(results.suites)
  return rows
}

export function markdown(rows) {
  const icon = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' }
  const link = (n) => `[#${n}](https://github.com/${REPO}/issues/${n})`
  const lines = ['## Live journey matrix', '', '| Journey | Result | Owning issues |', '|---|---|---|']
  for (const r of rows) lines.push(`| ${r.id} ${r.title} | ${icon[r.status]} | ${r.issues.map(link).join(', ')} |`)
  const failed = rows.filter((r) => r.status === 'failed')
  if (failed.length === 0) lines.push('', rows.some((r) => r.status === 'passed') ? 'All journeys that ran passed.' : 'No journey ran (test accounts are not configured).')
  for (const r of failed) {
    lines.push('', `### ${r.id} ${r.title} failed`, '', `Report it on ${link(r.issues[0])}${r.issues.length > 1 ? ` (also touches ${r.issues.slice(1).map(link).join(', ')})` : ''}.`, '', '```', r.error ?? 'no error message', '```')
    lines.push('', `Artifacts${RUN_URL ? ` (download from [the run](${RUN_URL}))` : ''}: ${r.artifacts.length ? r.artifacts.join(', ') : 'none'}. \`action-trail.json\` lists every action the journey called, in order, with status, timing, inputs and result.`)
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  if (!existsSync(file)) {
    console.log(`no ${file}; nothing to report`)
  } else {
    const out = markdown(summarise(JSON.parse(readFileSync(file, 'utf8'))))
    console.log(out)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out)
  }
}
