import type {} from "bun-webgpu"

// Only for the private pixel adapter's device and bun-webgpu 0.1.7, not browser WebGPU.
export function managePixelGpu(device: GPUDevice, context: GPUCanvasContext) {
  const encoders = new Set<GPUCommandEncoder & { _destroyed: boolean }>()
  const passes = new Set<GPURenderPassEncoder>()
  const buffers = new Set<GPUCommandBuffer>()
  const counts = {
    encodersCreated: 0,
    encodersFinished: 0,
    encodersReleased: 0,
    passesCreated: 0,
    passesEnded: 0,
    passesReleased: 0,
    commandBuffersCreated: 0,
    commandBuffersSubmitted: 0,
    commandBuffersReleased: 0,
    canvasViewsCreated: 0,
    canvasViewsReleased: 0,
  }
  const queue = device.queue
  const createEncoder = device.createCommandEncoder
  const submit = queue.submit
  const getCurrentTexture = context.getCurrentTexture
  let canvasTexture: GPUTexture | undefined
  let createView: GPUTexture["createView"] | undefined
  let canvasView: GPUTextureView | undefined
  let disposed = false

  function checkCapacity() {
    // The arena needs three encoders per frame. Bound abandoned work, not frame history.
    if (encoders.size + passes.size + buffers.size >= 64) throw new Error("Too many pending GPU handles")
  }

  device.createCommandEncoder = (descriptor) => {
    checkCapacity()
    const encoder = createEncoder.call(device, descriptor) as GPUCommandEncoder & { _destroyed: boolean }
    if (typeof encoder._destroy !== "function" || encoder._destroyed !== false)
      throw new Error("Expected bun-webgpu 0.1.7 command encoder ownership")
    encoders.add(encoder)
    counts.encodersCreated++
    const begin = encoder.beginRenderPass
    const finish = encoder.finish
    encoder.beginRenderPass = (descriptor) => {
      checkCapacity()
      const pass = begin.call(encoder, descriptor)
      if (typeof pass.destroy !== "function") throw new Error("Expected bun-webgpu render pass destroy()")
      passes.add(pass)
      counts.passesCreated++
      const end = pass.end
      pass.end = () => {
        if (!passes.delete(pass)) throw new Error("Render pass is not pending")
        try {
          end.call(pass)
          counts.passesEnded++
        } finally {
          pass.destroy()
          counts.passesReleased++
        }
      }
      return pass
    }
    encoder.finish = (descriptor) => {
      if (!encoders.has(encoder)) throw new Error("Command encoder is not pending")
      const buffer = finish.call(encoder, descriptor)
      // finish() already releases the encoder's API reference. Never release it again.
      encoders.delete(encoder)
      counts.encodersFinished++
      counts.encodersReleased++
      if (typeof buffer._destroy !== "function") throw new Error("Expected bun-webgpu command buffer _destroy()")
      buffers.add(buffer)
      counts.commandBuffersCreated++
      return buffer
    }
    return encoder
  }

  queue.submit = (commands) => {
    const list = Array.isArray(commands) ? commands : Array.from(commands)
    for (const buffer of list) {
      if (!buffers.has(buffer)) throw new Error("Command buffer is not owned or was already submitted")
    }
    try {
      submit.call(queue, list)
      counts.commandBuffersSubmitted += list.length
    } finally {
      for (const buffer of list) {
        if (!buffers.delete(buffer)) continue
        buffer._destroy()
        counts.commandBuffersReleased++
      }
    }
  }

  function releaseCanvasView() {
    if (canvasTexture && createView) canvasTexture.createView = createView
    canvasTexture = undefined
    createView = undefined
    if (!canvasView) return
    const view = canvasView
    canvasView = undefined
    view.destroy()
    counts.canvasViewsReleased++
  }

  context.getCurrentTexture = () => {
    const texture = getCurrentTexture.call(context)
    if (texture === canvasTexture) return texture
    releaseCanvasView()
    canvasTexture = texture
    const original = texture.createView
    createView = original
    texture.createView = (descriptor) => {
      // Three 0.177.0 requests only the default canvas view. Other textures are untouched.
      if (descriptor !== undefined) throw new Error("Cached canvas views require the default descriptor")
      if (canvasView) return canvasView
      const view = original.call(texture, descriptor)
      if (typeof view.destroy !== "function") throw new Error("Expected bun-webgpu texture view destroy()")
      counts.canvasViewsCreated++
      canvasView = view
      return view
    }
    return texture
  }

  function discardPending() {
    for (const pass of passes) {
      passes.delete(pass)
      pass.destroy()
      counts.passesReleased++
    }
    for (const buffer of buffers) {
      buffers.delete(buffer)
      buffer._destroy()
      counts.commandBuffersReleased++
    }
    for (const encoder of encoders) {
      encoders.delete(encoder)
      if (!encoder._destroyed) encoder._destroy()
      counts.encodersReleased++
    }
  }

  return {
    discardPending,
    snapshot() {
      return {
        ...counts,
        pendingEncoders: encoders.size,
        pendingPasses: passes.size,
        pendingCommandBuffers: buffers.size,
        cachedCanvasViews: Number(canvasView !== undefined),
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        discardPending()
      } finally {
        try {
          releaseCanvasView()
        } finally {
          device.createCommandEncoder = createEncoder
          queue.submit = submit
          context.getCurrentTexture = getCurrentTexture
        }
      }
    },
  }
}
