<script setup lang="ts">
const { data } = await useAsyncData('other', async () => ({ title: 'Other page', body: 'All read' }), { deep: true })
</script>

<template>
  <main><h1>{{ data?.title }}</h1><p>{{ data?.body }}</p></main>
</template>
