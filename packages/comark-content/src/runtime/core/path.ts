export function generatedTitle(path: string) {
  const part = path.split('/').filter(Boolean).at(-1) || 'Home'
  return part.split(/[-_]/).filter(Boolean).map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ')
}
