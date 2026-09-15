import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { findBaseline } = require('../.github/actions/nuxt-dx-budget/baseline.cjs')
const head = 'a'.repeat(40)
const older = 'b'.repeat(40)
const future = 'c'.repeat(40)
const prefix = 'budget-prod--'
function artifact(sha, overrides = {}) {
  return { id: 1, name: prefix + sha, expired: false, workflow_run: { id: 10, head_branch: 'main', head_repository_id: 7 }, ...overrides }
}
function options(pages, compare = async () => ({ data: { status: 'ahead' } })) {
  return {
    github: {
      rest: {
        actions: { async listArtifactsForRepo({ page }) {
          return { data: { artifacts: pages[page - 1] ?? [] }, headers: { link: page < pages.length ? '<https://api.github.com/next>; rel="next"' : '' } }
        } },
        repos: { compareCommitsWithBasehead: compare },
      },
    },
    repo: { owner: 'owner', repo: 'repo' }, repositoryId: 7, runId: 20,
    artifactName: 'budget-prod', baseBranch: 'main', headSha: head,
  }
}

test('finds an ancestor after empty pages and skipped builds', async () => {
  const pages = Array.from({ length: 25 }, () => [artifact(older, { name: 'unrelated' })])
  pages.push([artifact(older)])
  assert.deepEqual(await findBaseline(options(pages)), { id: 1, runId: 10, name: prefix + older, sha: older })
})
test('rejects reruns, foreign repositories, expired reports, and other branches', async () => {
  const result = await findBaseline(options([[
    artifact(older, { expired: true }),
    artifact(older, { workflow_run: { id: 20, head_branch: 'main', head_repository_id: 7 } }),
    artifact(older, { workflow_run: { id: 9, head_branch: 'pr', head_repository_id: 7 } }),
    artifact(older, { workflow_run: { id: 9, head_branch: 'main', head_repository_id: 8 } }),
  ]]))
  assert.equal(result, null)
})
test('skips future and diverged commits when runs finish out of order', async () => {
  const visited = []
  const result = await findBaseline(options([[artifact(future), artifact(older)]], async ({ basehead }) => {
    visited.push(basehead)
    return { data: { status: basehead.startsWith(future) ? 'behind' : 'ahead' } }
  }))
  assert.equal(result.sha, older)
  assert.deepEqual(visited, [`${future}...${head}`, `${older}...${head}`])
})
test('does not read legacy artifacts with unknown source commits', async () => {
  assert.equal(await findBaseline(options([[artifact(older, { name: 'budget-prod' })]])), null)
})
test('surfaces API failures instead of claiming a missing baseline', async () => {
  await assert.rejects(findBaseline(options([[artifact(older)]], async () => { throw new Error('rate limited') })), /rate limited/)
  const input = options([])
  input.github.rest.actions.listArtifactsForRepo = async () => { throw new Error('unauthorized') }
  await assert.rejects(findBaseline(input), /unauthorized/)
})

test('stops baseline lookup when a fork head cannot be resolved', async () => {
  const compared = []
  const result = await findBaseline(options([[artifact(older), artifact(future)]], async ({ basehead }) => {
    compared.push(basehead)
    throw Object.assign(new Error('Not Found'), { status: 404 })
  }))
  assert.equal(result, null)
  assert.deepEqual(compared, [`${older}...${head}`])
})

test('only treats comparison 404 responses as a missing baseline', async () => {
  for (const status of [401, 403, 429, 500]) {
    const error = Object.assign(new Error('API failure'), { status })
    await assert.rejects(findBaseline(options([[artifact(older)]], async () => { throw error })), error)
  }
  const input = options([])
  const error = Object.assign(new Error('Not Found'), { status: 404 })
  input.github.rest.actions.listArtifactsForRepo = async () => { throw error }
  await assert.rejects(findBaseline(input), error)
})

test('rejects malformed source identifiers without querying commits', async () => {
  const result = await findBaseline(options([[artifact('../main')]], async () => { throw new Error('unexpected comparison') }))
  assert.equal(result, null)
})
test('skips divergent histories', async () => {
  assert.equal(await findBaseline(options([[artifact(older)]], async () => ({ data: { status: 'diverged' } }))), null)
})


test('compares repeated content builds at the same source commit across runs', async () => {
  const result = await findBaseline(options([[artifact(head)]], async () => ({ data: { status: 'identical' } })))
  assert.equal(result.sha, head)
})
