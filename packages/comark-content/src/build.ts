export const runContentBuild = async (
  ingest: () => void | Promise<void>,
  refreshTemplates: () => void | Promise<void>,
) => {
  await ingest()
  await refreshTemplates()
}
