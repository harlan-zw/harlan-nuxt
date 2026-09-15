<script setup lang="ts">
const { data } = await useAsyncData('product', async () => ({ title: 'Book', details: 'Later details', unused: 'Unused data' }))
const showDetails = ref(false)
</script>

<template>
  <main>
    <h1>{{ data?.title }}</h1>
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
