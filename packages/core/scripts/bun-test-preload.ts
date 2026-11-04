// Bun can park in its poll after a setImmediate until its 1 s GC timer fires (oven-sh/bun#45020); this timer wakes it.
setInterval(() => {}, 10).unref()
