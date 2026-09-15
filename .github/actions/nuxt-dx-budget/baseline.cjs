/** Select a retained report from an earlier run, across workflows. */
async function findBaseline({ github, repo, repositoryId, runId, artifactName, baseBranch, headSha }) {
  const prefix = `${artifactName}--`
  for (let page = 1; ; page++) {
    const response = await github.rest.actions.listArtifacts({ ...repo, per_page: 100, page })
    for (const artifact of response.data.artifacts) {
      const run = artifact.workflow_run
      if (artifact.expired || !artifact.name.startsWith(prefix)
        || !run || run.id >= runId || run.head_branch !== baseBranch
        || run.head_repository_id !== repositoryId) continue
      const sha = artifact.name.slice(prefix.length)
      if (!/^[a-f0-9]{40}$/.test(sha)) continue
      const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${headSha}` })
      // Completion order can differ from commit order. Never compare backwards.
      if (data.status === 'ahead' || data.status === 'identical') return { id: artifact.id, runId: run.id, name: artifact.name, sha }
    }
    if (!response.headers.link?.includes('rel="next"')) return null
  }
}

module.exports = { findBaseline }
