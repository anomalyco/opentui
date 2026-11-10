export function parseIcyMetadata(bytes: Uint8Array, decoder: TextDecoder): Readonly<Record<string, string>> | null {
  const decoded = decoder.decode(bytes)
  const nul = decoded.indexOf("\0")
  const text = nul === -1 ? decoded : decoded.slice(0, nul)
  if (text.length === 0) return null

  const fields: Record<string, string> = Object.create(null)
  let found = false
  let offset = 0
  while (offset < text.length) {
    const separator = text.indexOf("='", offset)
    if (separator === -1) break
    const key = text.slice(offset, separator)
    if (key.length === 0 || /[';=]/.test(key)) break
    const end = text.indexOf("';", separator + 2)
    if (end === -1) break
    Object.defineProperty(fields, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: text.slice(separator + 2, end),
    })
    found = true
    offset = end + 2
  }
  return found ? Object.freeze(fields) : null
}
