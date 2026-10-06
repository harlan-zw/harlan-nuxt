<script setup lang="ts">
const fetched = await useNuxtQuery<{ value: number }>('/api/query', { key: 'migration-url' })
const handled = await useNuxtAsyncQuery(async () => ({ value: 7 }), { key: 'migration-handler' })
</script>

<template>
  <main>migration-query:{{ fetched.displayData.value?.value }}:{{ handled.displayData.value?.value }}:{{ fetched.isFetching.value }}</main>
</template>
