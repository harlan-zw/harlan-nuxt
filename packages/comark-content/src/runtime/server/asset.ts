export function decodeCollectionAsset<T>(value: Uint8Array, collection: string): Promise<T> {
  const source = Uint8Array.from(value).buffer
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text().then(text => JSON.parse(text) as T).catch((cause) => {
    throw new TypeError(`${collection}.json.gz:1:1 Could not decode the generated collection asset.`, { cause })
  })
}
