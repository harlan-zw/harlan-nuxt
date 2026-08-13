import { spawn } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'pathe'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(currentDirectory, '../..')
const fixtureRoot = resolve(currentDirectory, '../http')
const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : undefined

if (!outputDirectory)
  throw new TypeError('Pass an output directory to the CI build harness.')

function command(program, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, arguments_, {
      cwd: packageRoot,
      env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${program} exited with ${code}.`)))
  })
}

async function main() {
  await mkdir(outputDirectory)
  for (const fixture of ['disabled', 'enabled']) {
    const fixtureDirectory = join(fixtureRoot, fixture)
    await command('pnpm', ['exec', 'nuxi', 'build', fixtureDirectory, '--logLevel', 'silent'])
    await cp(
      join(fixtureDirectory, '.output/server'),
      join(outputDirectory, fixture),
      { recursive: true },
    )
  }
  await cp(
    join(packageRoot, 'dist/runtime/server/index.js'),
    join(outputDirectory, 'server-runtime.js'),
  )
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
