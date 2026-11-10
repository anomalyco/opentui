import * as THREE from "three"
import { TextureUtils } from "./TextureUtils.js"
import type { Scene } from "three"

export interface ResourceConfig {
  imagePath: string
  sheetNumFrames: number
}

export interface SheetProperties {
  imagePath: string
  sheetTilesetWidth: number
  sheetTilesetHeight: number
  sheetNumFrames: number
}

export interface InstanceManagerOptions {
  maxInstances: number
  renderOrder?: number
  depthWrite?: boolean
  name?: string
  frustumCulled?: boolean
  matrix?: THREE.Matrix4
}

export interface MeshPoolOptions {
  geometry: () => THREE.BufferGeometry
  material: THREE.Material
  maxInstances: number
  name?: string
}

const HIDDEN_MATRIX = new THREE.Matrix4().scale(new THREE.Vector3(0, 0, 0))

export class MeshPool {
  private pools: Map<string, THREE.InstancedMesh[]> = new Map()

  public acquireMesh(poolId: string, options: MeshPoolOptions): THREE.InstancedMesh {
    const poolArray = this.pools.get(poolId) ?? []
    this.pools.set(poolId, poolArray)

    if (poolArray.length > 0) {
      const mesh = poolArray.pop()!
      mesh.material = options.material
      mesh.count = options.maxInstances
      return mesh
    }

    const mesh = new THREE.InstancedMesh(options.geometry(), options.material, options.maxInstances)

    if (options.name) {
      mesh.name = options.name
    }

    return mesh
  }

  public releaseMesh(poolId: string, mesh: THREE.InstancedMesh): void {
    const poolArray = this.pools.get(poolId) ?? []
    poolArray.push(mesh)
    this.pools.set(poolId, poolArray)
  }

  public fill(poolId: string, options: MeshPoolOptions, count: number): void {
    const poolArray = this.pools.get(poolId) ?? []
    this.pools.set(poolId, poolArray)

    for (let i = 0; i < count; i++) {
      const mesh = new THREE.InstancedMesh(options.geometry(), options.material, options.maxInstances)

      if (options.name) {
        mesh.name = `${options.name}_${i}`
      }

      poolArray.push(mesh)
    }
  }

  public clearPool(poolId: string): void {
    const poolArray = this.pools.get(poolId)
    if (poolArray) {
      poolArray.forEach((mesh) => {
        mesh.geometry.dispose()
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((mat) => mat.dispose())
        } else {
          mesh.material.dispose()
        }
      })
      poolArray.length = 0
    }
  }

  public clearAllPools(): void {
    for (const poolId of this.pools.keys()) {
      this.clearPool(poolId)
    }
    this.pools.clear()
  }
}

export class InstanceManager {
  private scene: Scene
  private instancedMesh: THREE.InstancedMesh
  private material: THREE.Material
  private maxInstances: number
  private _freeIndices: number[] = []
  private instanceCount: number = 0
  private _matrix: THREE.Matrix4

  constructor(scene: Scene, geometry: THREE.BufferGeometry, material: THREE.Material, options: InstanceManagerOptions) {
    this.scene = scene
    this.material = material
    this.maxInstances = options.maxInstances
    this._matrix = options.matrix ?? HIDDEN_MATRIX

    this.instancedMesh = new THREE.InstancedMesh(geometry, material, this.maxInstances)
    this.instancedMesh.renderOrder = options.renderOrder ?? 0
    this.instancedMesh.frustumCulled = options.frustumCulled ?? false
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    if (options.name) {
      this.instancedMesh.name = options.name
    }

    for (let i = 0; i < this.maxInstances; i++) {
      this._freeIndices.push(i)
      this.instancedMesh.setMatrixAt(i, this._matrix)
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true

    this.scene.add(this.instancedMesh)
  }

  acquireInstanceSlot(): number {
    if (this._freeIndices.length === 0) {
      throw new Error(`[InstanceManager] Max instances (${this.maxInstances}) reached. Cannot acquire slot.`)
    }
    const instanceIndex = this._freeIndices.pop()!
    this.instanceCount++
    return instanceIndex
  }

  releaseInstanceSlot(instanceIndex: number): void {
    if (instanceIndex >= 0 && instanceIndex < this.maxInstances) {
      this.instancedMesh.setMatrixAt(instanceIndex, this._matrix)
      this.instancedMesh.instanceMatrix.needsUpdate = true

      if (!this._freeIndices.includes(instanceIndex)) {
        this._freeIndices.push(instanceIndex)
        this._freeIndices.sort((a, b) => a - b)
        this.instanceCount--
      }
    } else {
      console.warn(`[InstanceManager] Attempted to release invalid instanceIndex ${instanceIndex}`)
    }
  }

  getInstanceCount(): number {
    return this.instanceCount
  }

  getMaxInstances(): number {
    return this.maxInstances
  }

  get hasFreeIndices(): boolean {
    return this._freeIndices.length > 0
  }

  get mesh(): THREE.InstancedMesh {
    return this.instancedMesh
  }

  dispose(): void {
    this.scene.remove(this.instancedMesh)
    this.instancedMesh.geometry.dispose()
    if (Array.isArray(this.material)) {
      this.material.forEach((mat) => mat.dispose())
    } else {
      this.material.dispose()
    }
  }
}

export class SpriteResource {
  private _texture: THREE.DataTexture
  private _sheetProperties: SheetProperties
  private scene: Scene
  private _meshPool: MeshPool

  constructor(texture: THREE.DataTexture, sheetProperties: SheetProperties, scene: Scene) {
    this._texture = texture
    this._sheetProperties = sheetProperties
    this.scene = scene
    this._meshPool = new MeshPool()
  }

  public get texture(): THREE.DataTexture {
    return this._texture
  }

  public get sheetProperties(): SheetProperties {
    return this._sheetProperties
  }

  public get meshPool(): MeshPool {
    return this._meshPool
  }

  public createInstanceManager(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    options: InstanceManagerOptions,
  ): InstanceManager {
    const managerOptions = {
      ...options,
      name: options.name ?? `InstancedSprites_${this._sheetProperties.imagePath.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    }

    return new InstanceManager(this.scene, geometry, material, managerOptions)
  }

  public get uvTileSize(): THREE.Vector2 {
    const uvTileWidth = 1.0 / this._sheetProperties.sheetNumFrames
    const uvTileHeight = 1.0
    return new THREE.Vector2(uvTileWidth, uvTileHeight)
  }

  public dispose(): void {
    this._meshPool.clearAllPools()
  }
}

export class SpriteResourceManager {
  private resources: Map<string, SpriteResource> = new Map()
  private textureCache: Map<string, THREE.DataTexture> = new Map()
  private scene: Scene

  constructor(scene: Scene) {
    this.scene = scene
  }

  private getResourceKey(sheetProps: SheetProperties): string {
    return sheetProps.imagePath
  }

  public async getOrCreateResource(texture: THREE.DataTexture, sheetProps: SheetProperties): Promise<SpriteResource> {
    const resourceKey = this.getResourceKey(sheetProps)
    let resource = this.resources.get(resourceKey)

    if (!resource) {
      resource = new SpriteResource(texture, sheetProps, this.scene)
      this.resources.set(resourceKey, resource)
    }

    return resource
  }

  public async createResource(config: ResourceConfig): Promise<SpriteResource> {
    let texture = this.textureCache.get(config.imagePath)
    if (!texture) {
      const loadedTexture = await TextureUtils.fromFile(config.imagePath)
      if (!loadedTexture) {
        throw new Error(`[SpriteResourceManager] Failed to load texture for ${config.imagePath}`)
      }
      loadedTexture.needsUpdate = true
      texture = loadedTexture
      this.textureCache.set(config.imagePath, texture)
    }

    const sheetProps: SheetProperties = {
      imagePath: config.imagePath,
      sheetTilesetWidth: texture.image.width,
      sheetTilesetHeight: texture.image.height,
      sheetNumFrames: config.sheetNumFrames,
    }

    return await this.getOrCreateResource(texture, sheetProps)
  }

  public clearCache(): void {
    this.resources.clear()
    this.textureCache.clear()
  }
}
