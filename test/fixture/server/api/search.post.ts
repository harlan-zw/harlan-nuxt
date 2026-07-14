interface SearchBody {
  limit: number
  term: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<SearchBody>(event)
  return {
    limit: body.limit,
    term: body.term,
  }
})
