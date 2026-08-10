<script setup lang="ts">
import type { JobBroadcastEnvelope } from '#cf-jobs/app'

function assertBroadcastTypes() {
  const channel = useCfJobsChannel<JobBroadcastEnvelope<'sync/table'>>(cfJobsChannel('tenant', 'site_1'), (event) => {
    const status: 'claimed' | 'completed' | 'failed' | 'released' = event.data.status
    const name: 'sync.table.updated' = event.event
    void status
    void name
  })
  void channel
}

void assertBroadcastTypes
</script>

<template>
  <NuxtPage />
</template>
