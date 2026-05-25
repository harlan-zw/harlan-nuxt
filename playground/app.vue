<script setup lang="ts">
const { data, displayData, status } = await useNuxtQuery<{ message: string }>('/api/hello', {
  key: 'hello',
})
</script>

<template>
  <main>
    <h1>Nuxt Use Query</h1>
    <pre>{{ { data, displayData, status } }}</pre>
  </main>
</template>
