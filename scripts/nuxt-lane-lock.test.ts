import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { parse, stringify } from 'yaml'
import { refreshLocalArchive } from './nuxt-lane-lock.ts'

test('a rebuilt local archive installs with a frozen lock after a version bump', async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'nuxt-lane-lock-'))
  const producer = resolve(fixture, 'producer')
  const consumer = resolve(fixture, 'consumer')
  const run = (args: string[], cwd = consumer) => execFileSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_WORKSPACE_DIR: cwd, npm_config_workspace_dir: cwd },
  })
  try {
    await mkdir(producer)
    await mkdir(consumer)
    await writeFile(resolve(consumer, 'pnpm-workspace.yaml'), stringify({
      minimumReleaseAge: 0,
      minimumReleaseAgeExclude: ['lane-fixture@0.2.1', 'lane-fixture@0.2.2'],
      trustPolicyExclude: ['lane-fixture@0.2.1', 'lane-fixture@0.2.2'],
    }))
    await writeFile(resolve(consumer, 'package.json'), JSON.stringify({
      private: true,
      packageManager: 'pnpm@11.2.1',
      dependencies: { 'lane-fixture': 'file:./fixture.tgz' },
    }))
    for (const version of ['0.2.1', '0.2.2']) {
      await writeFile(resolve(producer, 'package.json'), JSON.stringify({ name: 'lane-fixture', version, main: 'index.cjs' }))
      await writeFile(resolve(producer, 'index.cjs'), `module.exports = '${version}'\n`)
      run(['pack', '--ignore-scripts', '--out', resolve(consumer, 'fixture.tgz')], producer)
      if (version === '0.2.1')
        run(['install', '--lockfile-only', '--ignore-scripts'])
    }
    const lockPath = resolve(consumer, 'pnpm-lock.yaml')
    const lock = parse(await readFile(lockPath, 'utf8'))
    const key = 'lane-fixture@file:fixture.tgz'
    lock.packages[key] = refreshLocalArchive(lock.packages[key], await readFile(resolve(consumer, 'fixture.tgz')), '0.2.2')
    assert.equal(lock.packages[key].version, '0.2.2')
    await writeFile(lockPath, stringify(lock))
    run(['install', '--frozen-lockfile', '--ignore-scripts', '--config.strict-store-pkg-content-check=true'])
    assert.equal(run(['exec', 'node', '-p', 'require("lane-fixture")']).trim(), '0.2.2')
  }
  finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
