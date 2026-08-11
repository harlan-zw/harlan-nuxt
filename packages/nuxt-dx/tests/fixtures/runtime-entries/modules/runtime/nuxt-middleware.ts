export default defineNuxtRouteMiddleware((to) => {
  if (to.path === '/owned-runtime-budget-fixture')
    return abortNavigation()
})
