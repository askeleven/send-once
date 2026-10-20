import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** @param {string[]} args */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * @param {string} key
 * @param {'pending'|'sent'|'failed'} status
 * @param {string} claimedAt
 * @param {Record<string, unknown>} [extra]
 */
const entry = (key, status, claimedAt, extra = {}) =>
  JSON.stringify({ key, status, attempts: 1, claimedAt, updatedAt: claimedAt, meta: null, ...extra })

const OLD = 'a'.repeat(64)
const RECENT = 'b'.repeat(64)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'send-once-cli-'))
  const path = join(dir, 'ledger.jsonl')
  const now = new Date().toISOString()
  await writeFile(
    path,
    [
      entry('sent-1', 'pending', '2026-01-01T00:00:00.000Z'),
      entry('sent-1', 'sent', '2026-01-01T00:00:00.000Z', { sentAt: '2026-01-01T00:00:01.000Z' }),
      entry('failed-1', 'failed', '2026-01-02T00:00:00.000Z', { error: '422 invalid recipient' }),
      entry(OLD, 'pending', '2026-01-03T00:00:00.000Z', {
        meta: { channel: 'email', to: 'ana@example.com', intent: 'renewal' },
        error: 'Delivery is unknown: ETIMEDOUT',
        uncertain: true,
      }),
      entry(RECENT, 'pending', now),
      '',
    ].join('\n'),
  )
  return { dir, path }
}

test('audit exits 1 and lists every pending entry', async () => {
  const { path } = await fixture()
  const r = run(['audit', path])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /^\nUNKNOWN {2}2 sends may or may not have gone out\n/)
  assert.match(r.stdout, /4 in the ledger\n\s+1 sent\n\s+1 failed, may be retried\n\s+2 pending/)
  assert.ok(r.stdout.includes(OLD))
  assert.ok(r.stdout.includes(RECENT))
  assert.match(r.stdout, /\n {6}channel: email\n {6}to: ana@example.com\n {6}intent: renewal\n/)
  assert.match(r.stdout, /last error: Delivery is unknown: ETIMEDOUT/)
  assert.ok(r.stdout.includes(`send-once resolve ${path} <key> sent`))
})

test('audit --older-than leaves out sends that may still be in flight', async () => {
  const { path } = await fixture()
  const r = run(['audit', path, '--older-than', '1h', '--json'])
  assert.equal(r.code, 1)
  const report = JSON.parse(r.stdout)
  assert.deepEqual(report.unknown.map((/** @type {any} */ u) => u.key), [OLD])
  assert.equal(report.inFlight, 1)
  assert.deepEqual(report.counts, { total: 4, sent: 1, failed: 1, pending: 2 })
  assert.equal(report.olderThanMs, 3_600_000)
  assert.deepEqual(report.unknown[0].meta, { channel: 'email', to: 'ana@example.com', intent: 'renewal' })
})

test('resolve settles entries, and audit exits 0 once nothing is unknown', async () => {
  const { path } = await fixture()
  let r = run(['resolve', path, OLD, 'sent', '--by', 'ops', '--note', 'in provider log'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, `Resolved ${OLD} as sent. It will not be sent again.\n`)

  r = run(['resolve', path, RECENT, 'failed', '--json'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).status, 'failed')

  r = run(['resolve', path, OLD, 'sent'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /was already sent\. Nothing changed\./)

  r = run(['audit', path])
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /^\nOK {2}Nothing unresolved in /)

  const last = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.key === OLD && e.status === 'sent')
  assert.equal(last.resolution.by, 'ops')
  assert.equal(last.resolution.note, 'in provider log')
})

test('resolve refuses with 1, and bad input exits 2', async () => {
  const { dir, path } = await fixture()
  assert.equal(run(['resolve', path, 'sent-1', 'failed']).code, 1, 'a sent entry cannot be made retryable')
  assert.equal(run(['resolve', path, 'no-such-key', 'sent']).code, 1)
  assert.equal(run(['resolve', path, OLD, 'maybe']).code, 2)
  assert.equal(run(['resolve', path, OLD]).code, 2)

  assert.equal(run(['audit', join(dir, 'missing.jsonl')]).code, 2)
  assert.equal(run(['audit', path, '--older-than', '10 minutes']).code, 2)
  assert.equal(run(['audit']).code, 2)
  assert.equal(run(['frobnicate']).code, 2)
  assert.equal(run(['audit', path, '--bogus']).code, 2)

  const csv = join(dir, 'list.csv')
  await writeFile(csv, 'email,name\nana@example.com,Ana\n')
  const r = run(['audit', csv])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /is not a send-once ledger/)
})

test('an empty ledger is fine, and --version and --help work', async () => {
  const { dir } = await fixture()
  const empty = join(dir, 'empty.jsonl')
  await writeFile(empty, '')
  assert.equal(run(['audit', empty]).code, 0)

  const v = run(['--version'])
  assert.equal(v.code, 0)
  assert.equal(v.stdout, `${pkg.version}\n`)
  const h = run(['--help'])
  assert.equal(h.code, 0)
  assert.match(h.stdout, /send-once audit <ledger.jsonl>/)
})
