export default defineNuxtRouteMiddleware((to) => {
  if (to.path === '/runtime-budget-fixture')
    return abortNavigation()
})
