import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { consola } from 'consola'
import { parse } from 'yaml'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      'yes': { type: 'boolean', short: 'y' },
      'help': { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    consola.log('Usage: pnpm release [package] [--dry-run] [--yes]')
    consola.log('Publish a stable package version already merged into origin/main.')
    return
  }
  if (positionals.length > 1)
    throw new Error('Choose one package: pnpm release [package] [--dry-run] [--yes].')

  git('fetch', 'origin', 'refs/heads/main')
  const commit = git('rev-parse', 'FETCH_HEAD')
  const workflow = parse(git('show', `${commit}:.github/workflows/release.yml`))
  const packages = workflow.on.push.tags
    .filter(tag => tag.endsWith('-v*'))
    .map(tag => tag.slice(0, -3))
    .sort()

  let selected = positionals[0]?.replace(/^@harlan-zw\//, '')
  if (!selected) {
    if (!process.stdin.isTTY)
      throw new Error('Choose a package: pnpm release <package> [--dry-run] [--yes].')
    selected = await consola.prompt('Choose a package to publish:', {
      type: 'select',
      options: packages,
      cancel: 'reject',
    })
  }
  if (!packages.includes(selected))
    throw new Error(`Unknown package: ${selected}. Choose: ${packages.join(', ')}.`)

  const manifest = JSON.parse(git('show', `${commit}:packages/${selected}/package.json`))
  if (manifest.private)
    throw new Error(`Package ${selected} is private.`)
  if (typeof manifest.version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.version))
    throw new Error('The publisher requires a stable version, such as 1.2.3.')

  const tag = `${selected}-v${manifest.version}`
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`))
    throw new Error(`Tag ${tag} already exists. Merge a version bump before releasing again.`)

  consola.info(`Release: ${manifest.name}@${manifest.version}`)
  consola.info(`Commit: ${commit} (origin/main)`)
  consola.info(`Tag: ${tag}`)
  if (values['dry-run']) {
    consola.success('Dry run complete. No tag was pushed.')
    return
  }
  if (!values.yes) {
    if (!process.stdin.isTTY)
      throw new Error('If you want to publish, run again with --yes.')
    const confirmed = await consola.prompt('Push this tag and start npm publishing?', {
      type: 'confirm',
      initial: false,
      cancel: 'reject',
    })
    if (!confirmed)
      return
  }

  // Push only the selected tag. Local changes and branches stay outside the release.
  git('push', 'origin', `${commit}:refs/tags/${tag}`)
  consola.success(`Pushed ${tag}. GitHub Actions will publish the package.`)
}

main().catch((error) => {
  consola.error(error.message)
  process.exitCode = 1
})
