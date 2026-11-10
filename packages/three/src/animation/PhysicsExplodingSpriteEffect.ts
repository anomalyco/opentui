import * as THREE from "three"
import { texture as tslTexture, uv, vec2, attribute } from "three/tsl"
import { MeshBasicNodeMaterial, NodeMaterial } from "three/webgpu"
import type { TiledSprite, SpriteDefinition, SpriteAnimator } from "./SpriteAnimator.js"
import type {
  PhysicsRigidBody,
  PhysicsWorld,
  PhysicsRigidBodyDesc,
  PhysicsColliderDesc,
  PhysicsVector2,
} from "../physics/physics-interface.js"
import type { SpriteResource } from "../SpriteResourceManager.js"

export interface PhysicsExplosionEffectParameters {
  numRows: number
  numCols: number
  durationMs: number
  explosionForce: number
  forceVariation: number
  torqueStrength: number
  gravityScale: number
  fadeOut: boolean
  linearDamping: number
  angularDamping: number
  restitution: number
  friction: number
  density: number
  materialFactory: () => NodeMaterial
}

export const DEFAULT_PHYSICS_EXPLOSION_PARAMETERS: PhysicsExplosionEffectParameters = {
  numRows: 5,
  numCols: 5,
  durationMs: 3000,
  explosionForce: 25.0,
  forceVariation: 0.4,
  torqueStrength: 15.0,
  gravityScale: 1.0,
  fadeOut: true,
  linearDamping: 0.8,
  angularDamping: 0.5,
  restitution: 0.3,
  friction: 0.7,
  density: 1.0,
  materialFactory: () =>
    new MeshBasicNodeMaterial({
      transparent: true,
      alphaTest: 0.01,
      // side: THREE.DoubleSide,
      depthWrite: false,
    }),
}

export interface PhysicsExplosionCreationData {
  resource: SpriteResource
  frameUvOffset: THREE.Vector2
  frameUvSize: THREE.Vector2
  spriteWorldTransform: THREE.Matrix4
}

export interface PhysicsSpriteRecreationData {
  definition: SpriteDefinition
  currentTransform: {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  }
}

export interface PhysicsExplosionHandle {
  readonly effect: PhysicsExplodingSpriteEffect
  readonly recreationData: PhysicsSpriteRecreationData
  hasBeenRestored: boolean
  restoreSprite: (spriteAnimator: SpriteAnimator) => Promise<TiledSprite | null>
}

interface ExplosionParticle {
  rigidBody: PhysicsRigidBody
  instanceIndex: number
  uvOffset: THREE.Vector2
  uvSize: THREE.Vector2
  initialOpacity: number
  lifeVariation: number
  id: string
}

export class PhysicsExplodingSpriteEffect {
  private static materialCache: Map<string, NodeMaterial> = new Map()

  private scene: THREE.Scene
  private physicsWorld: PhysicsWorld
  private resource: SpriteResource
  private frameUvOffset: THREE.Vector2
  private frameUvSize: THREE.Vector2
  private spriteWorldTransform: THREE.Matrix4
  private params: PhysicsExplosionEffectParameters

  private particles: ExplosionParticle[] = []
  private numParticles: number

  private instancedMesh!: THREE.InstancedMesh
  private material!: NodeMaterial
  private uvOffsetAttribute!: THREE.InstancedBufferAttribute

  public isActive: boolean = true
  private timeElapsedMs: number = 0
  private particleIdCounter: number = 0

  constructor(
    scene: THREE.Scene,
    physicsWorld: PhysicsWorld,
    resource: SpriteResource,
    frameUvOffset: THREE.Vector2,
    frameUvSize: THREE.Vector2,
    spriteWorldTransform: THREE.Matrix4,
    userParams?: Partial<PhysicsExplosionEffectParameters>,
  ) {
    this.scene = scene
    this.physicsWorld = physicsWorld
    this.resource = resource
    this.frameUvOffset = frameUvOffset
    this.frameUvSize = frameUvSize
    this.spriteWorldTransform = spriteWorldTransform
    this.params = { ...DEFAULT_PHYSICS_EXPLOSION_PARAMETERS, ...userParams }

    this.numParticles = this.params.numRows * this.params.numCols
    const materialFactory = userParams?.materialFactory ?? DEFAULT_PHYSICS_EXPLOSION_PARAMETERS.materialFactory

    this._createPhysicsParticles(materialFactory)
  }

  private _createPhysicsParticles(materialFactory: () => NodeMaterial): void {
    if (this.numParticles === 0) return

    const particleUnitWidth = 1.0 / this.params.numCols
    const particleUnitHeight = 1.0 / this.params.numRows

    const spriteWorldCenter = new THREE.Vector3().setFromMatrixPosition(this.spriteWorldTransform)
    const spriteScale = new THREE.Vector3().setFromMatrixScale(this.spriteWorldTransform)
    const avgScale = (spriteScale.x + spriteScale.y) * 0.5
    const uvOffsetData = new Float32Array(this.numParticles * 4)

    let particleIndex = 0
    for (let r = 0; r < this.params.numRows; r++) {
      for (let c = 0; c < this.params.numCols; c++) {
        const localParticlePosX = (c + 0.5) * particleUnitWidth - 0.5
        const localParticlePosY = (r + 0.5) * particleUnitHeight - 0.5

        const initialLocalPosition = new THREE.Vector3(localParticlePosX, localParticlePosY, 0)
        const worldPosition = initialLocalPosition.clone().applyMatrix4(this.spriteWorldTransform)

        const rigidBodyDesc: PhysicsRigidBodyDesc = {
          translation: { x: worldPosition.x, y: worldPosition.y },
          linearDamping: this.params.linearDamping,
          angularDamping: this.params.angularDamping,
        }

        const rigidBody = this.physicsWorld.createRigidBody(rigidBodyDesc)

        const particlePhysicsWidth = particleUnitWidth * avgScale * 0.8
        const particlePhysicsHeight = particleUnitHeight * avgScale * 0.8
        const colliderDesc: PhysicsColliderDesc = {
          width: particlePhysicsWidth,
          height: particlePhysicsHeight,
          restitution: this.params.restitution,
          friction: this.params.friction,
          density: this.params.density,
        }

        this.physicsWorld.createCollider(colliderDesc, rigidBody)

        let explosionDir = worldPosition.clone().sub(spriteWorldCenter)
        if (explosionDir.lengthSq() < 0.0001) {
          explosionDir.set(Math.random() - 0.5, Math.random() - 0.5, 0)
        }
        explosionDir.normalize()

        const forceVariationRange = this.params.forceVariation
        const minForceFactor = 1.0 - forceVariationRange * 0.5
        const maxForceFactor = 1.0 + forceVariationRange * 0.5
        const forceFactor = minForceFactor + Math.random() * (maxForceFactor - minForceFactor)
        const explosionForce = this.params.explosionForce * forceFactor

        const forceVector: PhysicsVector2 = {
          x: explosionDir.x * explosionForce,
          y: explosionDir.y * explosionForce + explosionForce * 0.3, // Add upward bias
        }

        rigidBody.applyImpulse(forceVector)

        const torque = (Math.random() - 0.5) * this.params.torqueStrength
        rigidBody.applyTorqueImpulse(torque)

        const u0 = this.frameUvOffset.x + (c / this.params.numCols) * this.frameUvSize.x
        const v0 = this.frameUvOffset.y + (r / this.params.numRows) * this.frameUvSize.y
        const uSize = this.frameUvSize.x / this.params.numCols
        const vSize = this.frameUvSize.y / this.params.numRows

        const baseIndex = particleIndex * 4
        uvOffsetData[baseIndex] = u0
        uvOffsetData[baseIndex + 1] = v0
        uvOffsetData[baseIndex + 2] = uSize
        uvOffsetData[baseIndex + 3] = vSize

        const particleId = `explosion_particle_${this.particleIdCounter++}`
        const lifeVariation = 0.8 + Math.random() * 0.4

        const particle: ExplosionParticle = {
          rigidBody,
          instanceIndex: particleIndex,
          uvOffset: new THREE.Vector2(u0, v0),
          uvSize: new THREE.Vector2(uSize, vSize),
          initialOpacity: 1.0,
          lifeVariation,
          id: particleId,
        }

        this.particles.push(particle)
        particleIndex++
      }
    }

    this.uvOffsetAttribute = new THREE.InstancedBufferAttribute(uvOffsetData, 4)
    this.material = PhysicsExplodingSpriteEffect.getSharedMaterial(this.resource.texture, materialFactory)

    const poolKey = `${this.params.numRows}x${this.params.numCols}`

    this.instancedMesh = this.resource.meshPool.acquireMesh(poolKey, {
      geometry: () => new THREE.PlaneGeometry(particleUnitWidth, particleUnitHeight),
      material: this.material,
      maxInstances: this.numParticles,
      name: `PhysicsExplodingSprite_${poolKey}`,
    })

    this.instancedMesh.geometry.setAttribute("a_uvOffset", this.uvOffsetAttribute)

    this.instancedMesh.frustumCulled = false

    for (let i = 0; i < this.numParticles; i++) {
      this.instancedMesh.setMatrixAt(i, this.spriteWorldTransform)
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true

    this.scene.add(this.instancedMesh)
  }

  public static getSharedMaterial(texture: THREE.DataTexture, materialFactory: () => NodeMaterial): NodeMaterial {
    const key = texture.uuid
    const cached = PhysicsExplodingSpriteEffect.materialCache.get(key)
    if (cached) return cached

    const a_uvOffset = attribute("a_uvOffset", "vec4")
    const uvOffset = vec2(a_uvOffset.x, a_uvOffset.y)
    const uvSize = vec2(a_uvOffset.z, a_uvOffset.w)

    const baseUV = uv()
    const finalUV = baseUV.mul(uvSize).add(uvOffset)

    const mapNode = tslTexture(texture)
    const sampledColor = mapNode.sample(finalUV)

    const material = materialFactory()
    material.colorNode = sampledColor

    PhysicsExplodingSpriteEffect.materialCache.set(key, material)
    return material
  }

  update(deltaTimeMs: number): void {
    if (!this.isActive) return

    this.timeElapsedMs += deltaTimeMs

    const tempMatrix = new THREE.Matrix4()
    const tempScale = new THREE.Vector3()
    this.spriteWorldTransform.decompose(new THREE.Vector3(), new THREE.Quaternion(), tempScale)

    const axis = new THREE.Vector3(0, 0, 1)
    for (const particle of this.particles) {
      const position = particle.rigidBody.getTranslation()
      const rotation = particle.rigidBody.getRotation()
      const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, rotation)

      tempMatrix.compose(new THREE.Vector3(position.x, position.y, 0), quaternion, tempScale)

      this.instancedMesh.setMatrixAt(particle.instanceIndex, tempMatrix)
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true

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

    for (const particle of this.particles) {
      this.physicsWorld.removeRigidBody(particle.rigidBody)
    }
    this.particles = []
  }
}

export class PhysicsExplosionManager {
  private scene: THREE.Scene
  private physicsWorld: PhysicsWorld
  private activeExplosions: PhysicsExplodingSpriteEffect[] = []

  constructor(scene: THREE.Scene, physicsWorld: PhysicsWorld) {
    this.scene = scene
    this.physicsWorld = physicsWorld
  }

  public fillPool(
    resource: SpriteResource,
    count: number,
    params: Partial<PhysicsExplosionEffectParameters> = {},
  ): void {
    const effectParams = { ...DEFAULT_PHYSICS_EXPLOSION_PARAMETERS, ...params }
    const poolKey = `${effectParams.numRows}x${effectParams.numCols}`
    const particleUnitWidth = 1.0 / effectParams.numCols
    const particleUnitHeight = 1.0 / effectParams.numRows
    const numParticles = effectParams.numRows * effectParams.numCols

    const materialFactory = params.materialFactory ?? DEFAULT_PHYSICS_EXPLOSION_PARAMETERS.materialFactory
    const material = PhysicsExplodingSpriteEffect.getSharedMaterial(resource.texture, materialFactory)
    const geometry = new THREE.PlaneGeometry(particleUnitWidth, particleUnitHeight)

    resource.meshPool.fill(
      poolKey,
      {
        geometry: () => geometry,
        material,
        maxInstances: numParticles,
        name: `PhysicsExplodingSprite_${poolKey}`,
      },
      count,
    )
  }

  private _createEffectCreationData(sprite: TiledSprite): PhysicsExplosionCreationData {
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

  public async createExplosionForSprite(
    spriteToExplode: TiledSprite,
    userParams?: Partial<PhysicsExplosionEffectParameters>,
  ): Promise<PhysicsExplosionHandle | null> {
    const effectCreationData = this._createEffectCreationData(spriteToExplode)
    const definition = spriteToExplode.definition
    const transform = spriteToExplode.currentTransform
    const spriteRecreationData: PhysicsSpriteRecreationData = {
      definition: definition,
      currentTransform: transform,
    }

    spriteToExplode.destroy()

    const effect = new PhysicsExplodingSpriteEffect(
      this.scene,
      this.physicsWorld,
      effectCreationData.resource,
      effectCreationData.frameUvOffset,
      effectCreationData.frameUvSize,
      effectCreationData.spriteWorldTransform,
      userParams,
    )
    this.activeExplosions.push(effect)

    const handle: PhysicsExplosionHandle = {
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
