import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { parse, stringify } from 'yaml'

for (const lane of ['stable', 'nightly']) {
  test(`${lane} locked content parser links bare domains`, async () => {
    const lock = parse(await readFile(new URL(`../test/nuxt-migration/locks/${lane}.yaml`, import.meta.url), 'utf8'))
    const content = Object.entries(lock.snapshots).find(([name]) => name.startsWith('@harlan-zw/comark-content@file:'))?.[1] as { dependencies: Record<string, string> }
    const fixture = await mkdtemp(resolve(tmpdir(), 'nuxt-lane-content-'))
    const run = (argv: string[]) => execFileSync('pnpm', argv, {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, NPM_CONFIG_WORKSPACE_DIR: fixture, npm_config_workspace_dir: fixture },
    })
    try {
      await writeFile(resolve(fixture, 'package.json'), JSON.stringify({
        private: true,
        type: 'module',
        packageManager: 'pnpm@11.2.1',
        dependencies: Object.fromEntries(['comark', 'rangi'].map(name => [name, content.dependencies[name].split('(')[0]])),
      }))
      await writeFile(resolve(fixture, 'pnpm-workspace.yaml'), stringify({ minimumReleaseAge: 0 }))
      run(['install', '--ignore-scripts', '--reporter=append-only'])
      const document = JSON.parse(run(['exec', 'node', '--input-type=module', '-e', `
        import { createMarkdownParser } from 'comark'
        import linkify from 'comark/plugins/linkify'
        import titleDescription from 'comark/plugins/title-description'
        import toc from 'comark/plugins/toc'
        const parse = createMarkdownParser({ plugins: [linkify({ fuzzyLink: true, urlAuth: true }), titleDescription(), toc({ depth: 3, searchDepth: 3 })] })
        console.log(JSON.stringify(await parse('Visit www.example.com')))
      `]))
      assert.deepEqual(document.nodes, [['p', {}, 'Visit ', ['a', { href: 'http://www.example.com' }, 'www.example.com']]])
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
}
