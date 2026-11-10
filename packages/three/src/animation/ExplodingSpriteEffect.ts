import * as THREE from "three"
import {
  uniform,
  attribute,
  texture as tslTexture,
  uv,
  float,
  vec2,
  vec3,
  vec4,
  step,
  max,
  sin,
  cos,
  positionLocal,
  mat3,
} from "three/tsl"
import { MeshBasicNodeMaterial, NodeMaterial } from "three/webgpu"
import type { TiledSprite, SpriteDefinition, SpriteAnimator } from "./SpriteAnimator.js"
import type { SpriteResource } from "../SpriteResourceManager.js"

export interface ExplosionEffectParameters {
  numRows: number
  numCols: number
  durationMs: number
  strength: number
  strengthVariation: number
  gravity: number
  gravityScale: number
  fadeOut: boolean
  angularVelocityMin: THREE.Vector3
  angularVelocityMax: THREE.Vector3
  initialVelocityYBoost: number
  zVariationStrength: number
  materialFactory: () => NodeMaterial
}

export const DEFAULT_EXPLOSION_PARAMETERS: ExplosionEffectParameters = {
  numRows: 5,
  numCols: 5,
  durationMs: 2000,
  strength: 5,
  strengthVariation: 0.5,
  gravity: 9.8,
  gravityScale: 0.15,
  fadeOut: true,
  angularVelocityMin: new THREE.Vector3(-Math.PI, -Math.PI, -Math.PI),
  angularVelocityMax: new THREE.Vector3(Math.PI, Math.PI, Math.PI),
  initialVelocityYBoost: 1.0,
  zVariationStrength: 0.3,
  materialFactory: () =>
    new MeshBasicNodeMaterial({
      transparent: true,
      alphaTest: 0.01,
      side: THREE.DoubleSide,
      depthWrite: true,
    }),
}

export interface ExplosionCreationData {
  resource: SpriteResource
  frameUvOffset: THREE.Vector2
  frameUvSize: THREE.Vector2
  spriteWorldTransform: THREE.Matrix4
}

export interface SpriteRecreationData {
  definition: SpriteDefinition
  currentTransform: {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  }
}

export interface ExplosionHandle {
  readonly effect: ExplodingSpriteEffect
  readonly recreationData: SpriteRecreationData
  hasBeenRestored: boolean
  restoreSprite: (spriteAnimator: SpriteAnimator) => Promise<TiledSprite | null>
}

export class ExplodingSpriteEffect {
  private static baseMaterialCache: Map<string, NodeMaterial> = new Map()
  private scene: THREE.Scene
  private resource: SpriteResource
  private frameUvOffset: THREE.Vector2
  private frameUvSize: THREE.Vector2
  private spriteWorldTransform: THREE.Matrix4
  private params: ExplosionEffectParameters

  private instancedMesh!: THREE.InstancedMesh
  private material!: NodeMaterial
  private numParticles: number

  private uniformRefs!: { time: any; duration: any; gravity: any }

  public isActive: boolean = true
  private timeElapsedMs: number = 0

  constructor(
    scene: THREE.Scene,
    resource: SpriteResource,
    frameUvOffset: THREE.Vector2,
    frameUvSize: THREE.Vector2,
    spriteWorldTransform: THREE.Matrix4,
    userParams?: Partial<ExplosionEffectParameters>,
  ) {
    this.scene = scene
    this.resource = resource
    this.frameUvOffset = frameUvOffset
    this.frameUvSize = frameUvSize
    this.spriteWorldTransform = spriteWorldTransform
    this.params = { ...DEFAULT_EXPLOSION_PARAMETERS, ...userParams }

    this.numParticles = this.params.numRows * this.params.numCols
    const materialFactory = userParams?.materialFactory ?? DEFAULT_EXPLOSION_PARAMETERS.materialFactory

    this._createGPUParticles(materialFactory)
  }

  private _createGPUParticles(materialFactory: () => NodeMaterial): void {
    if (this.numParticles === 0) return

    const particleUnitWidth = 1.0 / this.params.numCols
    const particleUnitHeight = 1.0 / this.params.numRows

    const poolKey = `${this.params.numRows}x${this.params.numCols}`

    this._createGPUMaterial(materialFactory)

    this.instancedMesh = this.resource.meshPool.acquireMesh(poolKey, {
      geometry: () => {
        const geometry = new THREE.PlaneGeometry(particleUnitWidth, particleUnitHeight)
        geometry.setAttribute(
          "a_particleData",
          new THREE.InstancedBufferAttribute(new Float32Array(this.numParticles * 4), 4),
        )
        geometry.setAttribute(
          "a_velocity",
          new THREE.InstancedBufferAttribute(new Float32Array(this.numParticles * 4), 4),
        )
        geometry.setAttribute(
          "a_angularVel",
          new THREE.InstancedBufferAttribute(new Float32Array(this.numParticles * 4), 4),
        )
        geometry.setAttribute(
          "a_uvOffset",
          new THREE.InstancedBufferAttribute(new Float32Array(this.numParticles * 4), 4),
        )
        return geometry
      },
      material: this.material,
      maxInstances: this.numParticles,
      name: `ExplodingSprite_${poolKey}`,
    })

    const particleData: Float32Array = this.instancedMesh.geometry.getAttribute("a_particleData").array as Float32Array
    const velocityData: Float32Array = this.instancedMesh.geometry.getAttribute("a_velocity").array as Float32Array
    const angularVelData: Float32Array = this.instancedMesh.geometry.getAttribute("a_angularVel").array as Float32Array
    const uvOffsetData: Float32Array = this.instancedMesh.geometry.getAttribute("a_uvOffset").array as Float32Array

    const spriteWorldCenter = new THREE.Vector3().setFromMatrixPosition(this.spriteWorldTransform)

    let particleIndex = 0
    for (let r = 0; r < this.params.numRows; r++) {
      for (let c = 0; c < this.params.numCols; c++) {
        const localParticlePosX = (c + 0.5) * particleUnitWidth - 0.5
        const localParticlePosY = (r + 0.5) * particleUnitHeight - 0.5

        const initialLocalPosition = new THREE.Vector3(localParticlePosX, localParticlePosY, 0)
        const worldPosition = initialLocalPosition.clone().applyMatrix4(this.spriteWorldTransform)

        let velocityDir = worldPosition.clone().sub(spriteWorldCenter)
        if (velocityDir.lengthSq() < 0.0001) {
          velocityDir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        }
        velocityDir.normalize()

        const strengthVariationRange = this.params.strengthVariation
        const minStrengthFactor = 1.0 - strengthVariationRange * 0.5
        const maxStrengthFactor = 1.0 + strengthVariationRange * 0.5
        const strengthFactor = minStrengthFactor + Math.random() * (maxStrengthFactor - minStrengthFactor)
        const strength = this.params.strength * strengthFactor * 0.1
        const velocity = velocityDir.multiplyScalar(strength)

        if (
          Math.abs(this.spriteWorldTransform.elements[10]) < 0.1 &&
          Math.abs(this.spriteWorldTransform.elements[11]) < 0.1
        ) {
          velocity.z += (Math.random() - 0.5) * strength * this.params.zVariationStrength
        }

        velocity.y += this.params.strength * this.params.initialVelocityYBoost * Math.random()

        const angularVelocity = new THREE.Vector3(
          THREE.MathUtils.randFloat(this.params.angularVelocityMin.x, this.params.angularVelocityMax.x),
          THREE.MathUtils.randFloat(this.params.angularVelocityMin.y, this.params.angularVelocityMax.y),
          THREE.MathUtils.randFloat(this.params.angularVelocityMin.z, this.params.angularVelocityMax.z),
        )

        const lifeVariation = 0.8 + Math.random() * 0.4
        const randomSeed = Math.random()

        const u0 = this.frameUvOffset.x + (c / this.params.numCols) * this.frameUvSize.x
        const v0 = this.frameUvOffset.y + (r / this.params.numRows) * this.frameUvSize.y
        const uSize = this.frameUvSize.x / this.params.numCols
        const vSize = this.frameUvSize.y / this.params.numRows

        const baseIndex = particleIndex * 4

        particleData[baseIndex] = localParticlePosX
        particleData[baseIndex + 1] = localParticlePosY
        particleData[baseIndex + 2] = randomSeed
        particleData[baseIndex + 3] = lifeVariation

        velocityData[baseIndex] = velocity.x
        velocityData[baseIndex + 1] = velocity.y
        velocityData[baseIndex + 2] = velocity.z
        velocityData[baseIndex + 3] = 0.0

        angularVelData[baseIndex] = angularVelocity.x
        angularVelData[baseIndex + 1] = angularVelocity.y
        angularVelData[baseIndex + 2] = angularVelocity.z
        angularVelData[baseIndex + 3] = 0.0

        uvOffsetData[baseIndex] = u0
        uvOffsetData[baseIndex + 1] = v0
        uvOffsetData[baseIndex + 2] = uSize
        uvOffsetData[baseIndex + 3] = vSize

        particleIndex++
      }
    }

    this.instancedMesh.onBeforeRender = () => {
      this.uniformRefs.time.value = this.timeElapsedMs / 1000
    }

    this.timeElapsedMs = 0

    this.instancedMesh.geometry.getAttribute("a_particleData").needsUpdate = true
    this.instancedMesh.geometry.getAttribute("a_velocity").needsUpdate = true
    this.instancedMesh.geometry.getAttribute("a_angularVel").needsUpdate = true
    this.instancedMesh.geometry.getAttribute("a_uvOffset").needsUpdate = true

    this.instancedMesh.frustumCulled = false

    for (let i = 0; i < this.numParticles; i++) {
      this.instancedMesh.setMatrixAt(i, this.spriteWorldTransform)
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true

    this.scene.add(this.instancedMesh)
  }

  private _createGPUMaterial(materialFactory: () => NodeMaterial): void {
    const key = `${this.resource.texture.uuid}_${this.params.numRows}x${this.params.numCols}_${this.params.fadeOut ? 1 : 0}`

    let template = ExplodingSpriteEffect.baseMaterialCache.get(key)
    if (!template) {
      template = ExplodingSpriteEffect._buildTemplateMaterial(this.resource.texture, this.params, materialFactory)
      ExplodingSpriteEffect.baseMaterialCache.set(key, template)
    }

    this.material = template
    this.uniformRefs = template.userData.uniformRefs as { time: any; duration: any; gravity: any }
  }

  public static _buildTemplateMaterial(
    texture: THREE.DataTexture,
    params: ExplosionEffectParameters,
    materialFactory: () => NodeMaterial,
  ): NodeMaterial {
    const timeUniformNode = uniform(0)
    ;(timeUniformNode as any).name = "timeUniform"
    const durationUniformNode = uniform(params.durationMs / 1000)
    ;(durationUniformNode as any).name = "durationUniform"
    const gravityUniformNode = uniform(params.gravity * params.gravityScale)
    ;(gravityUniformNode as any).name = "gravityUniform"

    const a_particleData = attribute("a_particleData", "vec4")
    const a_velocity = attribute("a_velocity", "vec4")
    const a_angularVel = attribute("a_angularVel", "vec4")
    const a_uvOffset = attribute("a_uvOffset", "vec4")

    const localPos = vec2(a_particleData.x, a_particleData.y)
    const lifeVariation = a_particleData.w

    const initialVelocity = vec3(a_velocity.x, a_velocity.y, a_velocity.z)
    const angularVelocity = vec3(a_angularVel.x, a_angularVel.y, a_angularVel.z)

    const uvOffset = vec2(a_uvOffset.x, a_uvOffset.y)
    const uvSize = vec2(a_uvOffset.z, a_uvOffset.w)

    const particleLifetime = durationUniformNode.mul(lifeVariation)
    const normalizedTime = timeUniformNode.div(particleLifetime)
    const isAlive = step(normalizedTime, float(1.0))

    const deltaTime = timeUniformNode
    const gravity = vec3(float(0), gravityUniformNode.negate(), float(0))

    const velocityContribution = initialVelocity.mul(deltaTime)
    const gravityContribution = gravity.mul(deltaTime).mul(deltaTime).mul(float(0.5))
    const positionOffset = velocityContribution.add(gravityContribution)

    const rotationAmount = angularVelocity.mul(deltaTime)
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
    const finalOffset = vec3(localPos.x, localPos.y, float(0)).add(positionOffset)

    let opacity = float(1.0)
    if (params.fadeOut) {
      const fadeStart = float(0.7)
      const fadeProgress = max(float(0), normalizedTime.sub(fadeStart).div(float(1.0).sub(fadeStart)))
      opacity = float(1.0).sub(fadeProgress)
    }
    opacity = opacity.mul(isAlive)

    const baseUV = uv()
    const finalUV = baseUV.mul(uvSize).add(uvOffset)

    const mapNode = tslTexture(texture)
    const sampledColor = mapNode.sample(finalUV)

    const material = materialFactory()

    const finalColor = vec4(sampledColor.rgb, sampledColor.a.mul(opacity))
    material.colorNode = finalColor
    material.positionNode = rotatedVertexPosition.add(finalOffset)

    material.userData.uniformRefs = {
      time: timeUniformNode,
      duration: durationUniformNode,
      gravity: gravityUniformNode,
    }

    return material
  }

  update(deltaTimeMs: number): void {
    if (!this.isActive) return

    this.timeElapsedMs += deltaTimeMs

    if (this.timeElapsedMs >= this.params.durationMs) {
      this.dispose()
    }
  }

  dispose(): void {
    if (!this.isActive) return
    this.isActive = false

    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh)

      const poolKey = `${this.params.numRows}x${this.params.numCols}`

      this.resource.meshPool.releaseMesh(poolKey, this.instancedMesh)
    }
  }
}

export class ExplosionManager {
  private scene: THREE.Scene
  private activeExplosions: ExplodingSpriteEffect[] = []

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  public fillPool(resource: SpriteResource, count: number, params: Partial<ExplosionEffectParameters> = {}): void {
    const effectParams = { ...DEFAULT_EXPLOSION_PARAMETERS, ...params }
    const poolKey = `${effectParams.numRows}x${effectParams.numCols}`
    const particleUnitWidth = 1.0 / effectParams.numCols
    const particleUnitHeight = 1.0 / effectParams.numRows
    const numParticles = effectParams.numRows * effectParams.numCols
    const materialFactory = params.materialFactory ?? DEFAULT_EXPLOSION_PARAMETERS.materialFactory

    const material = ExplodingSpriteEffect._buildTemplateMaterial(resource.texture, effectParams, materialFactory)

    resource.meshPool.fill(
      poolKey,
      {
        geometry: () => {
          const geometry = new THREE.PlaneGeometry(particleUnitWidth, particleUnitHeight)
          const particleData = new Float32Array(numParticles * 4)
          const velocityData = new Float32Array(numParticles * 4)
          const angularVelData = new Float32Array(numParticles * 4)
          const uvOffsetData = new Float32Array(numParticles * 4)
          const particleDataAttribute = new THREE.InstancedBufferAttribute(particleData, 4)
          const velocityAttribute = new THREE.InstancedBufferAttribute(velocityData, 4)
          const angularVelAttribute = new THREE.InstancedBufferAttribute(angularVelData, 4)
          const uvOffsetAttribute = new THREE.InstancedBufferAttribute(uvOffsetData, 4)

          geometry.setAttribute("a_particleData", particleDataAttribute)
          geometry.setAttribute("a_velocity", velocityAttribute)
          geometry.setAttribute("a_angularVel", angularVelAttribute)
          geometry.setAttribute("a_uvOffset", uvOffsetAttribute)

          particleDataAttribute.needsUpdate = true
          velocityAttribute.needsUpdate = true
          angularVelAttribute.needsUpdate = true
          uvOffsetAttribute.needsUpdate = true

          return geometry
        },
        material,
        maxInstances: numParticles,
        name: `ExplodingSprite_${poolKey}`,
      },
      count,
    )
  }

  private _createEffectCreationData(sprite: TiledSprite): ExplosionCreationData {
    const animState = sprite.currentAnimation.state
    const resource = sprite.currentAnimation.getResource()
    const currentAbsoluteFrame = animState.animFrameOffset + sprite.currentAnimation.currentLocalFrame
    const frameUOffset = currentAbsoluteFrame * resource.uvTileSize.x
    return {
      resource: resource,
      frameUvOffset: new THREE.Vector2(frameUOffset, 0),
      frameUvSize: resource.uvTileSize.clone(),
      spriteWorldTransform: sprite.getWorldTransform(),
    }
  }

  public createExplosionForSprite(
    spriteToExplode: TiledSprite,
    userParams?: Partial<ExplosionEffectParameters>,
  ): ExplosionHandle | null {
    const effectCreationData = this._createEffectCreationData(spriteToExplode)
    const definition = spriteToExplode.definition
    const transform = spriteToExplode.currentTransform

    let spriteRecreationData: SpriteRecreationData = {
      definition: definition,
      currentTransform: transform,
    }

    spriteToExplode.destroy()

    const effect = new ExplodingSpriteEffect(
      this.scene,
      effectCreationData.resource,
      effectCreationData.frameUvOffset,
      effectCreationData.frameUvSize,
      effectCreationData.spriteWorldTransform,
      userParams,
    )
    this.activeExplosions.push(effect)

    const handle: ExplosionHandle = {
      effect: effect,
      recreationData: spriteRecreationData,
      hasBeenRestored: false,
      restoreSprite: async (spriteAnimator: SpriteAnimator): Promise<TiledSprite | null> => {
        if (handle.hasBeenRestored) {
          return null
        }

        handle.effect.dispose()

        const newSprite = await spriteAnimator.createSprite(handle.recreationData.definition)
        const currentSpriteTransform = handle.recreationData.currentTransform
        newSprite.setTransform(
          currentSpriteTransform.position,
          currentSpriteTransform.quaternion,
          currentSpriteTransform.scale,
        )
        handle.hasBeenRestored = true

        return newSprite
      },
    }
    return handle
  }

  public update(deltaTimeMs: number): void {
    for (let i = this.activeExplosions.length - 1; i >= 0; i--) {
      const explosion = this.activeExplosions[i]
      explosion.update(deltaTimeMs)
      if (!explosion.isActive) {
        this.activeExplosions.splice(i, 1)
      }
    }
  }

  public disposeAll(): void {
    this.activeExplosions.forEach((exp) => exp.dispose())
    this.activeExplosions = []
  }
}
