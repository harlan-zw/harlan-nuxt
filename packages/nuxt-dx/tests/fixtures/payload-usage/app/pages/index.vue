<script setup lang="ts">
const { data } = await useAsyncData('product', async () => ({ title: 'Book', details: 'Later details', unused: 'Unused data' }))
const showDetails = ref(false)
const route = useRoute()
</script>

<template>
  <main>
    <h1>{{ data?.title }}</h1>
    <p>Query keys: {{ Object.keys(route.query).length }}</p>
    <button @click="showDetails = true">
      Show details
    </button>
    <p v-if="showDetails">
      {{ data?.details }}
    </p>
    <NuxtLink to="/other">
      Other page
    </NuxtLink>
  </main>
</template>
