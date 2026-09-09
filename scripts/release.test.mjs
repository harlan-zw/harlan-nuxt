/* eslint test/no-import-node-test: off -- The root CLI uses Node's built-in test runner. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const command = fileURLToPath(new URL('./release.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harlan-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'checkout')
  const remote = join(root, 'origin.git')
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' })
  mkdirSync(cwd)
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Release Test')
  git('config', 'user.email', 'release@example.test')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'commit.gpgsign', 'false')
  git('remote', 'add', 'origin', remote)
  mkdirSync(join(cwd, '.github/workflows'), { recursive: true })
  writeFileSync(join(cwd, '.github/workflows/release.yml'), 'on:\n  push:\n    tags:\n      - nuxt-dx-v*\n      - nuxt-use-query-v*\n')
  for (const name of ['nuxt-dx', 'nuxt-use-query']) {
    mkdirSync(join(cwd, 'packages', name), { recursive: true })
    writeFileSync(join(cwd, 'packages', name, 'package.json'), JSON.stringify({ name: `@harlan-zw/${name}`, version: '1.2.3' }))
  }
  git('add', '.')
  git('commit', '-m', 'chore: create release fixture')
  git('push', '-u', 'origin', 'main')
  const sha = git('rev-parse', 'HEAD')
  const run = (...args) => spawnSync(process.execPath, [command, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  return { cwd, git, sha, run }
}

test('publishes only the selected package tag at remote main', (t) => {
  const { git, run, sha } = fixture(t)
  git('switch', '-c', 'feature/unmerged')
  git('commit', '--allow-empty', '-m', 'feat: keep an unmerged change')
  const result = run('nuxt-dx', '--yes')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git('ls-remote', '--tags', 'origin'), `${sha}\trefs/tags/nuxt-dx-v1.2.3`)
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main'), `${sha}\trefs/heads/main`)
  assert.equal(git('branch', '--show-current'), 'feature/unmerged')
})

test('dry run leaves the remote without tags', (t) => {
  const { git, run } = fixture(t)
  const result = run('@harlan-zw/nuxt-dx', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /nuxt-dx-v1\.2\.3/)
  assert.equal(git('ls-remote', '--tags', 'origin'), '')
})

test('rejects an existing release tag without changing it', (t) => {
  const { git, run, sha } = fixture(t)
  git('push', 'origin', `${sha}:refs/tags/nuxt-dx-v1.2.3`)
  const result = run('nuxt-dx', '--yes')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /already exists/)
  assert.equal(git('ls-remote', '--tags', 'origin'), `${sha}\trefs/tags/nuxt-dx-v1.2.3`)
})

test('rejects unknown packages before publishing', (t) => {
  const { git, run } = fixture(t)
  const result = run('../nuxt-dx', '--yes')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown package/)
  assert.equal(git('ls-remote', '--tags', 'origin'), '')
})

test('requires explicit confirmation without a terminal', (t) => {
  const { git, run } = fixture(t)
  const result = run('nuxt-dx')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--yes/)
  assert.equal(git('ls-remote', '--tags', 'origin'), '')
})

test('rejects prereleases because the publisher uses latest', (t) => {
  const { cwd, git, run } = fixture(t)
  writeFileSync(join(cwd, 'packages/nuxt-dx/package.json'), JSON.stringify({ name: '@harlan-zw/nuxt-dx', version: '1.3.0-beta.1' }))
  git('add', '.')
  git('commit', '-m', 'chore: prepare prerelease')
  git('push')
  const result = run('nuxt-dx', '--yes')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /stable version/)
  assert.equal(git('ls-remote', '--tags', 'origin'), '')
})

test('rejects private packages before publishing', (t) => {
  const { cwd, git, run } = fixture(t)
  writeFileSync(join(cwd, 'packages/nuxt-dx/package.json'), JSON.stringify({ name: '@harlan-zw/nuxt-dx', version: '1.2.3', private: true }))
  git('add', '.')
  git('commit', '-m', 'chore: make package private')
  git('push')
  const result = run('nuxt-dx', '--yes')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /is private/)
  assert.equal(git('ls-remote', '--tags', 'origin'), '')
})

test('stops when the remote cannot be fetched', (t) => {
  const { cwd, git, run } = fixture(t)
  git('remote', 'set-url', 'origin', join(cwd, 'missing.git'))
  const result = run('nuxt-dx', '--yes')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /git fetch/)
  assert.equal(git('tag', '--list'), '')
})
