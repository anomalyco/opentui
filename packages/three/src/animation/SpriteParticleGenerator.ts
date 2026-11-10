import * as THREE from "three"
import {
  uniform,
  texture as tslTexture,
  uv,
  float,
  vec2,
  vec3,
  vec4,
  bufferAttribute,
  step,
  max,
  sin,
  cos,
  positionLocal,
  mat3,
  mix,
  floor,
  mod,
} from "three/tsl"
import { MeshBasicNodeMaterial, NodeMaterial } from "three/webgpu"
import type { SpriteResource, InstanceManager } from "../SpriteResourceManager.js"

export interface ParticleEffectParameters {
  resource: SpriteResource
  animNumFrames?: number
  animFrameOffset?: number
  frameDuration?: number
  loop?: boolean
  scale?: number
  renderOrder?: number
  depthWrite?: boolean
  maxParticles: number
  lifetimeMsMin: number
  lifetimeMsMax: number
  origins: THREE.Vector3[]
  spawnRadius: number | THREE.Vector3
  initialVelocityMin: THREE.Vector3
  initialVelocityMax: THREE.Vector3
  angularVelocityMin: THREE.Vector3
  angularVelocityMax: THREE.Vector3
  gravity?: THREE.Vector3
  randomGravityFactorMinMax?: THREE.Vector2
  scaleOverLifeMinMax?: THREE.Vector2
  fadeOut?: boolean
  materialFactory?: () => NodeMaterial
}

interface AutoSpawnConfig {
  resolvedParams: ParticleEffectParameters
  originalOverrides?: Partial<ParticleEffectParameters>
  ratePerSecond: number
  accumulator: number
}

interface ParticleSlot {
  isActive: boolean
  spawnTime: number
  lifespan: number
}

export class SpriteParticleGenerator {
  private scene: THREE.Scene
  private baseConfig: ParticleEffectParameters
  private autoSpawnConfig: AutoSpawnConfig | null = null
  private _currentOriginIndex: number = 0

  private instanceManager: InstanceManager | null = null
  private material: NodeMaterial | null = null
  private texture: THREE.DataTexture | null = null

  private particleDataAttribute: THREE.InstancedBufferAttribute | null = null // [originX, originY, originZ, spawnTime]
  private velocityAttribute: THREE.InstancedBufferAttribute | null = null // [velX, velY, velZ, gravityFactor]
  private angularVelAttribute: THREE.InstancedBufferAttribute | null = null // [angVelX, angVelY, angVelZ, lifespan]
  private scaleDataAttribute: THREE.InstancedBufferAttribute | null = null // [initialScale, scaleMin, scaleMax, randomSeed]

  private timeUniform: ReturnType<typeof uniform<number>>
  private gravityUniform: ReturnType<typeof uniform<THREE.Vector3>>
  private animationUniform: ReturnType<typeof uniform<THREE.Vector4>> // [frameDuration, animNumFrames, loop, animFrameOffset]
  private sheetNumFramesUniform: ReturnType<typeof uniform<number>>

  private particleSlots: ParticleSlot[] = []
  private currentTime: number = 0
  private maxParticles: number
  private isInitialized: boolean = false

  constructor(scene: THREE.Scene, initialBaseConfig: ParticleEffectParameters) {
    this.scene = scene
    this.baseConfig = { ...initialBaseConfig }
    this.maxParticles = this.baseConfig.maxParticles

    if (!this.baseConfig.resource) {
      throw new Error("[SpriteParticleGenerator] resource is mandatory in initialBaseConfig.")
    }

    this.timeUniform = uniform(0)
    this.gravityUniform = uniform(this.baseConfig.gravity || new THREE.Vector3(0, -9.8, 0))
    this.animationUniform = uniform(new THREE.Vector4())
    this.sheetNumFramesUniform = uniform(1)
  }

  private async _ensureInitialized(): Promise<void> {
    if (this.isInitialized) return
    await this._initializeGPUParticleSystem()
    this.isInitialized = true
  }

  private async _initializeGPUParticleSystem(): Promise<void> {
    const resource = this.baseConfig.resource

    this.texture = resource.texture

    // Set up animation uniforms from particle config
    const frameDuration = (this.baseConfig.frameDuration ?? 100) / 1000 // Convert to seconds
    const animNumFrames = this.baseConfig.animNumFrames ?? resource.sheetProperties.sheetNumFrames
    const loop = (this.baseConfig.loop ?? true) ? 1.0 : 0.0 // Default to true
    const animFrameOffset = this.baseConfig.animFrameOffset ?? 0

    this.animationUniform.value.set(frameDuration, animNumFrames, loop, animFrameOffset)
    this.sheetNumFramesUniform.value = resource.sheetProperties.sheetNumFrames

    const particleData = new Float32Array(this.maxParticles * 4)
    const velocityData = new Float32Array(this.maxParticles * 4)
    const angularVelData = new Float32Array(this.maxParticles * 4)
    const scaleData = new Float32Array(this.maxParticles * 4)

    this.particleDataAttribute = new THREE.InstancedBufferAttribute(particleData, 4)
    this.velocityAttribute = new THREE.InstancedBufferAttribute(velocityData, 4)
    this.angularVelAttribute = new THREE.InstancedBufferAttribute(angularVelData, 4)
    this.scaleDataAttribute = new THREE.InstancedBufferAttribute(scaleData, 4)

    this.particleDataAttribute.setUsage(THREE.DynamicDrawUsage)
    this.velocityAttribute.setUsage(THREE.DynamicDrawUsage)
    this.angularVelAttribute.setUsage(THREE.DynamicDrawUsage)
    this.scaleDataAttribute.setUsage(THREE.DynamicDrawUsage)

    for (let i = 0; i < this.maxParticles; i++) {
      this.particleSlots.push({ isActive: false, spawnTime: 0, lifespan: 0 })

      particleData[i * 4 + 3] = -1 // Mark as inactive with negative spawn time
    }

    const frameAspectRatio =
      this.texture.image.width / resource.sheetProperties.sheetNumFrames / this.texture.image.height
    const scale = this.baseConfig.scale ?? 1.0
    const geometry = new THREE.PlaneGeometry(scale * frameAspectRatio, scale)

    geometry.setAttribute("a_particleData", this.particleDataAttribute)
    geometry.setAttribute("a_velocity", this.velocityAttribute)
    geometry.setAttribute("a_angularVel", this.angularVelAttribute)
    geometry.setAttribute("a_scaleData", this.scaleDataAttribute)

    const materialFactory =
      this.baseConfig.materialFactory ??
      (() =>
        new MeshBasicNodeMaterial({
          transparent: true,
          alphaTest: 0.01,
          side: THREE.DoubleSide,
          depthWrite: this.baseConfig.depthWrite ?? false,
        }))
    const material = this._createGPUMaterial(materialFactory)
    this.instanceManager = resource.createInstanceManager(geometry, material, {
      maxInstances: this.maxParticles,
      renderOrder: this.baseConfig.renderOrder ?? 0,
      depthWrite: this.baseConfig.depthWrite ?? true,
      name: `SpriteParticleGenerator_${resource.sheetProperties.imagePath.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      matrix: new THREE.Matrix4(),
    })
  }

  private _createGPUMaterial(materialFactory: () => NodeMaterial): NodeMaterial {
    const a_particleData = bufferAttribute(this.particleDataAttribute!)
    const a_velocity = bufferAttribute(this.velocityAttribute!)
    const a_angularVel = bufferAttribute(this.angularVelAttribute!)
    const a_scaleData = bufferAttribute(this.scaleDataAttribute!)

    const origin = vec3(a_particleData.x, a_particleData.y, a_particleData.z)
    const spawnTime = a_particleData.w

    const initialVelocity = vec3(a_velocity.x, a_velocity.y, a_velocity.z)
    const gravityFactor = a_velocity.w

    const angularVelocity = vec3(a_angularVel.x, a_angularVel.y, a_angularVel.z)
    const lifespan = a_angularVel.w

    const initialScale = a_scaleData.x
    const scaleMin = a_scaleData.y
    const scaleMax = a_scaleData.z
    const randomSeed = a_scaleData.w

    const age = this.timeUniform.sub(spawnTime)
    const normalizedAge = age.div(lifespan)
    const isAlive = step(float(0), spawnTime).mul(step(normalizedAge, float(1.0)))

    const gravity = this.gravityUniform.mul(gravityFactor)
    const velocityContribution = initialVelocity.mul(age)
    const gravityContribution = gravity.mul(age).mul(age).mul(float(0.5))
    const currentPosition = origin.add(velocityContribution).add(gravityContribution)

    const rotationAmount = angularVelocity.mul(age)
    const cosX = cos(rotationAmount.x)
    const sinX = sin(rotationAmount.x)
    const cosY = cos(rotationAmount.y)
    const sinY = sin(rotationAmount.y)
    const cosZ = cos(rotationAmount.z)
    const sinZ = sin(rotationAmount.z)

    const rotationMatrix = mat3(
      cosY.mul(cosZ),
      cosY.mul(sinZ).negate(),
      sinY,
      sinX.mul(sinY).mul(cosZ).add(cosX.mul(sinZ)),
      sinX.mul(sinY).mul(sinZ).negate().add(cosX.mul(cosZ)),
      sinX.mul(cosY).negate(),
      cosX.mul(sinY).mul(cosZ).negate().add(sinX.mul(sinZ)),
      cosX.mul(sinY).mul(sinZ).add(sinX.mul(cosZ)),
      cosX.mul(cosY),
    )

    const rotatedVertexPosition = rotationMatrix.mul(positionLocal)

    let currentScale = initialScale
    if (this.baseConfig.scaleOverLifeMinMax) {
      const scaleMultiplier = mix(scaleMin, scaleMax, normalizedAge)
      currentScale = initialScale.mul(scaleMultiplier)
    }

    const scaledPosition = rotatedVertexPosition.mul(currentScale)
    const finalPosition = scaledPosition.add(currentPosition)

    let opacity = float(1.0)
    if (this.baseConfig.fadeOut) {
      const fadeStart = float(0.7)
      const fadeProgress = max(float(0), normalizedAge.sub(fadeStart).div(float(1.0).sub(fadeStart)))
      opacity = float(1.0).sub(fadeProgress)
    }
    opacity = opacity.mul(isAlive)

    // Dynamic frame calculation based on particle age
    const frameDuration = this.animationUniform.x
    const animNumFrames = this.animationUniform.y
    const loopFlag = this.animationUniform.z
    const animFrameOffset = this.animationUniform.w

    const frameFloat = age.div(frameDuration)
    const rawFrameIndex = floor(frameFloat)

    // Handle looping vs clamping
    const maxFrame = animNumFrames.sub(float(1))
    const clampedFrame = max(float(0), rawFrameIndex).min(maxFrame)
    const loopedFrame = rawFrameIndex.mod(animNumFrames)
    const finalLocalFrame = mix(clampedFrame, loopedFrame, loopFlag)

    const frameIndex = animFrameOffset.add(finalLocalFrame)

    const uvTileWidth = float(1.0).div(this.sheetNumFramesUniform)
    const uvOffset = vec2(frameIndex.mul(uvTileWidth), float(0))
    const uvSize = vec2(uvTileWidth, float(1.0))

    const baseUV = uv()
    const finalUV = baseUV.mul(uvSize).add(uvOffset)

    const mapNode = tslTexture(this.texture!)
    const sampledColor = mapNode.sample(finalUV)

    this.material = materialFactory()

    const finalColor = vec4(sampledColor.rgb, sampledColor.a.mul(opacity))
    this.material.colorNode = finalColor
    this.material.positionNode = finalPosition

    return this.material
  }

  private _resolveCurrentOrigin(originsArray: THREE.Vector3[]): THREE.Vector3 {
    const currentOrigin = originsArray[this._currentOriginIndex]
    this._currentOriginIndex = (this._currentOriginIndex + 1) % originsArray.length
    return currentOrigin
  }

  public getActiveParticleCount(): number {
    return this.particleSlots.filter((slot) => slot.isActive).length
  }

  private _resolveSpawnRadius(spawnRadius: number | THREE.Vector3): THREE.Vector3 {
    return typeof spawnRadius === "number" ? new THREE.Vector3(spawnRadius, spawnRadius, spawnRadius) : spawnRadius
  }

  private _spawnParticle(effectiveParams: Readonly<ParticleEffectParameters>, spawnRadiusVec: THREE.Vector3): void {
    if (!this.instanceManager?.hasFreeIndices) return

    const index = this.instanceManager!.acquireInstanceSlot()
    const particleOrigin = this._resolveCurrentOrigin(effectiveParams.origins)

    const spawnOffset = new THREE.Vector3(
      (Math.random() - 0.5) * 2 * spawnRadiusVec.x,
      (Math.random() - 0.5) * 2 * spawnRadiusVec.y,
      (Math.random() - 0.5) * 2 * spawnRadiusVec.z,
    )
    const initialPosition = new THREE.Vector3().copy(particleOrigin).add(spawnOffset)

    const velocity = new THREE.Vector3(
      THREE.MathUtils.randFloat(effectiveParams.initialVelocityMin.x, effectiveParams.initialVelocityMax.x),
      THREE.MathUtils.randFloat(effectiveParams.initialVelocityMin.y, effectiveParams.initialVelocityMax.y),
      THREE.MathUtils.randFloat(effectiveParams.initialVelocityMin.z, effectiveParams.initialVelocityMax.z),
    )

    const angularVelocity = new THREE.Vector3(
      THREE.MathUtils.randFloat(effectiveParams.angularVelocityMin.x, effectiveParams.angularVelocityMax.x),
      THREE.MathUtils.randFloat(effectiveParams.angularVelocityMin.y, effectiveParams.angularVelocityMax.y),
      THREE.MathUtils.randFloat(effectiveParams.angularVelocityMin.z, effectiveParams.angularVelocityMax.z),
    )

    const lifespan = THREE.MathUtils.randFloat(effectiveParams.lifetimeMsMin, effectiveParams.lifetimeMsMax) / 1000

    let gravityFactor = 1.0
    if (effectiveParams.randomGravityFactorMinMax) {
      gravityFactor = THREE.MathUtils.randFloat(
        effectiveParams.randomGravityFactorMinMax.x,
        effectiveParams.randomGravityFactorMinMax.y,
      )
    }

    const initialScale = effectiveParams.scale ?? 1.0
    let scaleMin = initialScale
    let scaleMax = initialScale
    if (effectiveParams.scaleOverLifeMinMax) {
      scaleMin = initialScale * effectiveParams.scaleOverLifeMinMax.x
      scaleMax = initialScale * effectiveParams.scaleOverLifeMinMax.y
    }

    this.particleDataAttribute!.setXYZW(
      index,
      initialPosition.x,
      initialPosition.y,
      initialPosition.z,
      this.currentTime,
    )
    this.velocityAttribute!.setXYZW(index, velocity.x, velocity.y, velocity.z, gravityFactor)
    this.angularVelAttribute!.setXYZW(index, angularVelocity.x, angularVelocity.y, angularVelocity.z, lifespan)
    this.scaleDataAttribute!.setXYZW(index, initialScale, scaleMin, scaleMax, Math.random())

    this.particleSlots[index] = {
      isActive: true,
      spawnTime: this.currentTime,
      lifespan: lifespan,
    }

    this.particleDataAttribute!.needsUpdate = true
    this.velocityAttribute!.needsUpdate = true
    this.angularVelAttribute!.needsUpdate = true
    this.scaleDataAttribute!.needsUpdate = true
  }

  public async spawnParticles(count: number, overrides: Partial<ParticleEffectParameters> = {}): Promise<void> {
    await this._ensureInitialized()
    if (count <= 0) return

    const finalParams: ParticleEffectParameters = {
      ...this.baseConfig,
      ...overrides,
    }

    const spawnRadiusVec = this._resolveSpawnRadius(finalParams.spawnRadius)

    for (let i = 0; i < count; i++) {
      this._spawnParticle(finalParams, spawnRadiusVec)
    }
  }

  public setAutoSpawn(ratePerSecond: number, autoSpawnParamOverrides: Partial<ParticleEffectParameters> = {}): void {
    if (ratePerSecond <= 0) {
      this.stopAutoSpawn()
      return
    }
    const originalOverridesToStore =
      Object.keys(autoSpawnParamOverrides).length > 0 ? { ...autoSpawnParamOverrides } : undefined

    this.autoSpawnConfig = {
      resolvedParams: { ...this.baseConfig, ...autoSpawnParamOverrides },
      originalOverrides: originalOverridesToStore,
      ratePerSecond: ratePerSecond,
      accumulator: 0,
    }
  }

  public hasAutoSpawn(): boolean {
    return this.autoSpawnConfig !== null
  }

  public stopAutoSpawn(): void {
    this.autoSpawnConfig = null
  }

  public async update(deltaTimeMs: number): Promise<void> {
    await this._ensureInitialized()

    this.currentTime += deltaTimeMs / 1000
    this.timeUniform.value = this.currentTime

    if (this.autoSpawnConfig) {
      this.autoSpawnConfig.accumulator += deltaTimeMs
      const particlesToSpawnThisFrame = Math.floor(
        this.autoSpawnConfig.accumulator * (this.autoSpawnConfig.ratePerSecond / 1000),
      )

      if (particlesToSpawnThisFrame > 0) {
        const spawnRadiusVec = this._resolveSpawnRadius(this.autoSpawnConfig.resolvedParams.spawnRadius)
        for (let i = 0; i < particlesToSpawnThisFrame; i++) {
          this._spawnParticle(this.autoSpawnConfig.resolvedParams, spawnRadiusVec)
        }
        this.autoSpawnConfig.accumulator -= (particlesToSpawnThisFrame * 1000) / this.autoSpawnConfig.ratePerSecond
      }
    }

    for (let i = 0; i < this.particleSlots.length; i++) {
      const slot = this.particleSlots[i]
      if (slot.isActive && this.currentTime - slot.spawnTime >= slot.lifespan) {
        slot.isActive = false
        this.particleDataAttribute!.setW(i, -1)
        this.instanceManager!.releaseInstanceSlot(i)
        this.particleDataAttribute!.needsUpdate = true
      }
    }
  }

  public dispose(): void {
    if (this.instanceManager) {
      this.instanceManager.dispose()
      this.material?.dispose()
    }
    this.stopAutoSpawn()
  }
}
