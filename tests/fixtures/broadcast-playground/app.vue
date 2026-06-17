<script setup lang="ts">
const jobId = ref('playground-job')
const batchId = ref('playground-batch')
const siteId = ref('playground-site')
const siteEvents = ref<unknown[]>([])

const job = useCfJob<{ message: string }>(jobId)
const batch = useCfJobBatch(batchId)
const site = useCfJobsChannel(cfJobsChannel('site', siteId.value), (event) => {
  siteEvents.value.push(event)
})

async function publishJob() {
  await $fetch('/api/publish', {
    method: 'POST',
    body: { kind: 'job', jobId: jobId.value },
  })
}

async function publishBatch() {
  await $fetch('/api/publish', {
    method: 'POST',
    body: { kind: 'batch', batchId: batchId.value },
  })
}

async function publishSite() {
  await $fetch('/api/publish', {
    method: 'POST',
    body: { kind: 'site', siteId: siteId.value },
  })
}
</script>

<template>
  <main>
    <h1>cf-jobs broadcast playground</h1>

    <section>
      <h2>Job</h2>
      <p data-testid="job-state">
        {{ job.state }}
      </p>
      <p data-testid="job-result">
        {{ job.result }}
      </p>
      <button type="button" @click="publishJob">
        Publish job
      </button>
    </section>

    <section>
      <h2>Batch</h2>
      <p data-testid="batch-finished">
        {{ batch.finished }}
      </p>
      <p data-testid="batch-progress">
        {{ batch.progress }}
      </p>
      <button type="button" @click="publishBatch">
        Publish batch
      </button>
    </section>

    <section>
      <h2>Site</h2>
      <p data-testid="site-status">
        {{ site.status }}
      </p>
      <p data-testid="site-events">
        {{ siteEvents.length }}
      </p>
      <button type="button" @click="publishSite">
        Publish site event
      </button>
    </section>
  </main>
</template>
