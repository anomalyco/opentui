import * as THREE from "three"
import { uniform, texture as tslTexture, uv, float, vec2, bufferAttribute, mix } from "three/tsl"
import { MeshBasicNodeMaterial, NodeMaterial } from "three/webgpu"
import type { Scene } from "three"
import { type SpriteResource, InstanceManager } from "../SpriteResourceManager.js"

export interface AnimationStateConfig {
  imagePath: string
  sheetNumFrames: number

  animNumFrames: number
  animFrameOffset: number

  frameDuration?: number
  loop?: boolean
  initialFrame?: number
  flipX?: boolean
  flipY?: boolean
}

export type ResolvedAnimationState = Required<AnimationStateConfig> & {
  sheetTilesetWidth: number
  sheetTilesetHeight: number
  texture: THREE.DataTexture
}

export interface AnimationDefinition {
  resource: SpriteResource
  animNumFrames?: number
  animFrameOffset?: number
  frameDuration?: number
  loop?: boolean
  initialFrame?: number
  flipX?: boolean
  flipY?: boolean
}

export interface SpriteDefinition {
  id?: string
  renderOrder?: number
  depthWrite?: boolean
  maxInstances?: number
  scale?: number
  initialAnimation: string
  animations: Record<string, AnimationDefinition>
}

const HIDDEN_MATRIX = new THREE.Matrix4().scale(new THREE.Vector3(0, 0, 0))

const DEFAULT_FRAME_DURATION = 100
const DEFAULT_INITIAL_FRAME = 0
const DEFAULT_SCALE = 1.0
const DEFAULT_FLIP_X = false
const DEFAULT_FLIP_Y = false

class Animation {
  public readonly name: string
  public state: ResolvedAnimationState
  private resource: SpriteResource
  public instanceIndex: number
  private instanceManager: InstanceManager
  private frameAttribute: THREE.InstancedBufferAttribute
  private flipAttribute: THREE.InstancedBufferAttribute

  public currentLocalFrame: number
  public timeAccumulator: number
  public isPlaying: boolean
  private _isActive: boolean = false

  constructor(
    name: string,
    state: ResolvedAnimationState,
    resource: SpriteResource,
    instanceIndex: number,
    instanceManager: InstanceManager,
    frameAttribute: THREE.InstancedBufferAttribute,
    flipAttribute: THREE.InstancedBufferAttribute,
  ) {
    this.name = name
    this.state = state
    this.resource = resource
    this.instanceIndex = instanceIndex
    this.instanceManager = instanceManager
    this.frameAttribute = frameAttribute
    this.flipAttribute = flipAttribute

    this.currentLocalFrame = state.initialFrame
    this.timeAccumulator = 0
    this.isPlaying = true

    this.instanceManager.mesh.setMatrixAt(this.instanceIndex, HIDDEN_MATRIX)
    const absoluteFrame = this.state.animFrameOffset + this.currentLocalFrame
    this.frameAttribute.setX(this.instanceIndex, absoluteFrame)
    this.flipAttribute.setXY(this.instanceIndex, this.state.flipX ? 1.0 : 0.0, this.state.flipY ? 1.0 : 0.0)
  }

  activate(worldTransform: THREE.Matrix4): void {
    this._isActive = true
    this.isPlaying = true // Start playing when activated
    this.currentLocalFrame = this.state.initialFrame // Reset to initial frame
    this.timeAccumulator = 0
    this.updateVisuals(worldTransform) // Apply transform and set frame
    // Ensure frame attribute is updated upon activation
    const absoluteFrame = this.state.animFrameOffset + this.currentLocalFrame
    this.frameAttribute.setX(this.instanceIndex, absoluteFrame)
    this.frameAttribute.needsUpdate = true // Mark manager for update
    this.flipAttribute.setXY(this.instanceIndex, this.state.flipX ? 1.0 : 0.0, this.state.flipY ? 1.0 : 0.0)
    this.flipAttribute.needsUpdate = true
  }

  deactivate(): void {
    this._isActive = false
    this.isPlaying = false
    this.instanceManager.mesh.setMatrixAt(this.instanceIndex, HIDDEN_MATRIX)
  }

  updateVisuals(worldTransform: THREE.Matrix4): void {
    if (!this._isActive) return
    this.instanceManager.mesh.setMatrixAt(this.instanceIndex, worldTransform)
  }

  updateTime(deltaTimeMs: number): boolean {
    // Returns true if frame attribute was updated
    if (!this.isPlaying || !this._isActive) return false

    this.timeAccumulator += deltaTimeMs
    let needsFrameAttributeUpdate = false

    if (this.timeAccumulator >= this.state.frameDuration) {
      const framesToAdvance = Math.floor(this.timeAccumulator / this.state.frameDuration)
      this.timeAccumulator %= this.state.frameDuration

      const oldLocalFrame = this.currentLocalFrame
      let nextLocalFrame = this.currentLocalFrame + framesToAdvance

      if (nextLocalFrame >= this.state.animNumFrames) {
        if (this.state.loop) {
          this.currentLocalFrame = nextLocalFrame % this.state.animNumFrames
        } else {
          this.currentLocalFrame = this.state.animNumFrames - 1
          this.isPlaying = false
        }
      } else {
        this.currentLocalFrame = nextLocalFrame
      }

      if (this.currentLocalFrame !== oldLocalFrame || !this.isPlaying) {
        const absoluteFrame = this.state.animFrameOffset + this.currentLocalFrame
        this.frameAttribute.setX(this.instanceIndex, absoluteFrame)
        this.frameAttribute.needsUpdate = true
        needsFrameAttributeUpdate = true
      }
    }
    return needsFrameAttributeUpdate
  }

  play(): void {
    if (!this._isActive) return
    this.isPlaying = true
  }

  stop(): void {
    this.isPlaying = false
  }

  goToFrame(localFrame: number): void {
    if (!this._isActive) return
    const targetLocalFrame = Math.max(0, Math.min(localFrame, this.state.animNumFrames - 1))
    if (this.currentLocalFrame !== targetLocalFrame) {
      this.currentLocalFrame = targetLocalFrame
      this.timeAccumulator = 0
      const absoluteFrame = this.state.animFrameOffset + this.currentLocalFrame
      this.frameAttribute.setX(this.instanceIndex, absoluteFrame)
      this.frameAttribute.needsUpdate = true // Mark manager for update
    }
  }

  setFrameDuration(newFrameDuration: number): void {
    if (newFrameDuration > 0) {
      this.state = { ...this.state, frameDuration: newFrameDuration }
    }
  }

  getResource(): SpriteResource {
    return this.resource
  }

  releaseInstanceSlot(): void {
    this.instanceManager.releaseInstanceSlot(this.instanceIndex)
  }
}

export class TiledSprite {
  public readonly id: string
  private animator: SpriteAnimator
  private _animations: Map<string, Animation>
  private _currentAnimation: Animation
  private _transformObject: THREE.Object3D

  private _reusableMatrix: THREE.Matrix4
  private _reusableAnimGeomScale: THREE.Vector3
  private _isVisibleState: boolean = true
  private originalDefinition: SpriteDefinition

  constructor(
    id: string,
    userSpriteDefinition: SpriteDefinition,
    animator: SpriteAnimator,
    animationInstanceParams: Array<{
      name: string
      state: ResolvedAnimationState
      resource: SpriteResource
      index: number
      instanceManager: InstanceManager
      frameAttribute: THREE.InstancedBufferAttribute
      flipAttribute: THREE.InstancedBufferAttribute
    }>,
  ) {
    this.id = id
    this.originalDefinition = userSpriteDefinition
    this.animator = animator
    this._transformObject = new THREE.Object3D()
    this._reusableMatrix = new THREE.Matrix4()
    this._reusableAnimGeomScale = new THREE.Vector3()

    const initialScale = userSpriteDefinition.scale ?? DEFAULT_SCALE
    this._transformObject.scale.set(initialScale, initialScale, initialScale)

    this._animations = new Map()
    for (const params of animationInstanceParams) {
      const anim = new Animation(
        params.name,
        params.state,
        params.resource,
        params.index,
        params.instanceManager,
        params.frameAttribute,
        params.flipAttribute,
      )
      this._animations.set(params.name, anim)
    }

    const initialAnim = this._animations.get(userSpriteDefinition.initialAnimation)
    if (!initialAnim) {
      throw new Error(
        `[TiledSprite] Initial animation "${userSpriteDefinition.initialAnimation}" not found for sprite "${this.id}".`,
      )
    }
    this._currentAnimation = initialAnim
    const initialWorldMatrix = this._calculateAnimationWorldMatrix(this._currentAnimation.state)
    this._currentAnimation.activate(initialWorldMatrix)
    this._isVisibleState = true
  }

  private _calculateAnimationWorldMatrix(animState: ResolvedAnimationState): THREE.Matrix4 {
    const matrix = this._reusableMatrix
    const animGeomScale = this._reusableAnimGeomScale
    const worldHeight = this._transformObject.scale.y
    const frameAspectRatio = animState.sheetTilesetWidth / animState.sheetNumFrames / animState.sheetTilesetHeight
    const worldWidth = worldHeight * frameAspectRatio
    animGeomScale.set(worldWidth, worldHeight, this._transformObject.scale.z)
    matrix.compose(this._transformObject.position, this._transformObject.quaternion, animGeomScale)
    return matrix
  }

  public get currentAnimation(): Animation {
    return this._currentAnimation
  }

  private updateCurrentAnimationVisuals(): void {
    if (this._isVisibleState) {
      const currentAnim = this.currentAnimation
      if (currentAnim) {
        const finalMatrix = this._calculateAnimationWorldMatrix(currentAnim.state)
        currentAnim.updateVisuals(finalMatrix)
      }
    }
  }

  setPosition(position: THREE.Vector3): void {
    this._transformObject.position.copy(position)
    this.updateCurrentAnimationVisuals()
  }

  setRotation(rotation: THREE.Quaternion): void {
    this._transformObject.quaternion.copy(rotation)
    this.updateCurrentAnimationVisuals()
  }

  setScale(scale: THREE.Vector3): void {
    this._transformObject.scale.copy(scale)
    this.updateCurrentAnimationVisuals()
  }

  getScale(): THREE.Vector3 {
    return this._transformObject.scale.clone()
  }

  setTransform(position: THREE.Vector3, rotation: THREE.Quaternion, newScale: THREE.Vector3): void {
    this._transformObject.position.copy(position)
    this._transformObject.quaternion.copy(rotation)
    this._transformObject.scale.copy(newScale)
    this.updateCurrentAnimationVisuals()
  }

  play(): void {
    this.currentAnimation.play()
  }
  stop(): void {
    this.currentAnimation.stop()
  }
  goToFrame(frame: number): void {
    this.currentAnimation.goToFrame(frame)
  }
  setFrameDuration(newFrameDuration: number): void {
    this.currentAnimation.setFrameDuration(newFrameDuration)
  }

  isPlaying(): boolean {
    return this.currentAnimation.isPlaying
  }

  async setAnimation(animationName: string): Promise<void> {
    const newAnim = this._animations.get(animationName)
    if (!newAnim) {
      throw new Error(`[TiledSprite] Animation "${animationName}" not found for sprite "${this.id}".`)
    }

    const switchingToSameAnimation = this._currentAnimation.name === animationName
    const oldAnim = this._currentAnimation

    if (!switchingToSameAnimation || !this._isVisibleState) {
      oldAnim?.deactivate()
    }

    this._currentAnimation = newAnim

    if (this._isVisibleState) {
      const finalMatrix = this._calculateAnimationWorldMatrix(newAnim.state)
      newAnim.activate(finalMatrix)
    } else {
      newAnim.deactivate()
    }
  }

  update(deltaTime: number): void {
    if (this.visible) {
      this.currentAnimation.updateTime(deltaTime)
    }
  }

  destroy(): void {
    this._animations.forEach((anim) => {
      anim.deactivate()
      anim.releaseInstanceSlot()
    })
    this._animations.clear()
    this._isVisibleState = false
  }

  getCurrentAnimationName(): string {
    return this._currentAnimation.name
  }

  getWorldTransform(): THREE.Matrix4 {
    return this._calculateAnimationWorldMatrix(this._currentAnimation.state)
  }

  getWorldPlaneSize(): THREE.Vector2 {
    const animState = this._currentAnimation.state
    const worldHeight = this._transformObject.scale.y
    const frameActualWidthPx = animState.sheetTilesetWidth / animState.sheetNumFrames
    const frameAspectRatio = frameActualWidthPx / animState.sheetTilesetHeight
    const worldWidth = worldHeight * frameAspectRatio
    return new THREE.Vector2(worldWidth, worldHeight)
  }

  get visible(): boolean {
    return this._isVisibleState
  }

  set visible(value: boolean) {
    if (this._isVisibleState === value) {
      return
    }
    this._isVisibleState = value
    if (value) {
      const finalMatrix = this._calculateAnimationWorldMatrix(this._currentAnimation.state)
      this._currentAnimation.activate(finalMatrix)
    } else {
      this._currentAnimation.deactivate()
    }
  }

  public get definition(): SpriteDefinition {
    return this.originalDefinition
  }

  public get currentTransform(): {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  } {
    return {
      position: this._transformObject.position.clone(),
      quaternion: this._transformObject.quaternion.clone(),
      scale: this._transformObject.scale.clone(),
    }
  }
}

interface SpriteAnimatorInstanceManager {
  instanceManager: InstanceManager
  frameAttribute: THREE.InstancedBufferAttribute
  flipAttribute: THREE.InstancedBufferAttribute
  uvTileSize: THREE.Vector2
}

export class SpriteAnimator {
  private instances: Map<string, TiledSprite> = new Map()
  private _idCounter = 0
  private instanceManagers: Map<string, SpriteAnimatorInstanceManager> = new Map()

  constructor(private scene: Scene) {}

  private createSpriteAnimationMaterial(
    resource: SpriteResource,
    frameAttribute: THREE.InstancedBufferAttribute,
    flipAttribute: THREE.InstancedBufferAttribute,
    materialFactory: () => NodeMaterial,
  ): NodeMaterial {
    const texture = resource.texture
    const sheetProps = resource.sheetProperties

    const uvTileWidth = 1.0 / sheetProps.sheetNumFrames
    const uvTileHeight = 1.0
    const uvTileSize = new THREE.Vector2(uvTileWidth, uvTileHeight)

    const tileSizeUniform = uniform(uvTileSize)
    const epsilon = float(0.000001)

    const baseUV = uv()
    const oneFloat = float(1.0)

    const a_frameIndex = bufferAttribute(frameAttribute)
    const a_flip = bufferAttribute(flipAttribute)

    const calculatedTileCoordX = a_frameIndex.mul(tileSizeUniform.x)
    const calculatedTileCoord = vec2(calculatedTileCoordX, float(0))

    const flippedX = mix(baseUV.x, oneFloat.sub(baseUV.x), a_flip.x)
    const flippedY = mix(baseUV.y, oneFloat.sub(baseUV.y), a_flip.y)
    const finalLocalUV = vec2(flippedX, flippedY)

    const mapNode = tslTexture(texture)
    const finalUV = finalLocalUV.mul(tileSizeUniform).min(tileSizeUniform.sub(epsilon)).add(calculatedTileCoord)
    const sampledColor = mapNode.sample(finalUV)

    const material = materialFactory()
    material.colorNode = sampledColor

    return material
  }

  private getOrCreateInstanceManager(
    resource: SpriteResource,
    maxInstances: number,
    renderOrder: number,
    depthWrite: boolean,
    materialFactory: () => NodeMaterial,
  ): SpriteAnimatorInstanceManager {
    const key = `${resource.sheetProperties.imagePath}_${maxInstances}_${renderOrder}_${depthWrite}`
    let manager = this.instanceManagers.get(key)

    if (!manager) {
      const geometry = new THREE.PlaneGeometry(1, 1)
      const frameArray = new Float32Array(maxInstances)
      const frameAttribute = new THREE.InstancedBufferAttribute(frameArray, 1)
      frameAttribute.setUsage(THREE.DynamicDrawUsage)

      const flipArray = new Float32Array(maxInstances * 2)
      const flipAttribute = new THREE.InstancedBufferAttribute(flipArray, 2)
      flipAttribute.setUsage(THREE.DynamicDrawUsage)

      const material = this.createSpriteAnimationMaterial(resource, frameAttribute, flipAttribute, materialFactory)

      geometry.setAttribute("a_frameIndexInstanced", frameAttribute)
      geometry.setAttribute("a_flipInstanced", flipAttribute)

      for (let i = 0; i < maxInstances; i++) {
        flipAttribute.setXY(i, 0.0, 0.0)
      }
      flipAttribute.needsUpdate = true

      const instanceManager = resource.createInstanceManager(geometry, material, {
        maxInstances,
        renderOrder,
        depthWrite,
        name: `SpriteAnimator_${key}`,
      })

      const uvTileWidth = 1.0 / resource.sheetProperties.sheetNumFrames
      const uvTileSize = new THREE.Vector2(uvTileWidth, 1.0)

      manager = {
        instanceManager,
        frameAttribute,
        flipAttribute,
        uvTileSize,
      }

      this.instanceManagers.set(key, manager)
    }

    return manager
  }

  async createSprite(
    userSpriteDefinition: SpriteDefinition,
    materialFactory?: () => NodeMaterial,
  ): Promise<TiledSprite> {
    const id = userSpriteDefinition.id ?? `sprite_${this._idCounter++}`
    const animationInstanceParams: Array<{
      name: string
      state: ResolvedAnimationState
      resource: SpriteResource
      index: number
      instanceManager: InstanceManager
      frameAttribute: THREE.InstancedBufferAttribute
      flipAttribute: THREE.InstancedBufferAttribute
    }> = []

    const resolvedMaterialFactory =
      materialFactory ??
      (() =>
        new MeshBasicNodeMaterial({
          transparent: true,
          alphaTest: 0.1,
          depthWrite: true,
        }))

    // Track instance managers as we encounter resources
    const resourceManagers = new Map<SpriteResource, SpriteAnimatorInstanceManager>()

    for (const animName in userSpriteDefinition.animations) {
      const animDef = userSpriteDefinition.animations[animName]
      const resource = animDef.resource

      // Get or create instance manager for this resource
      let managerInfo = resourceManagers.get(resource)
      if (!managerInfo) {
        const maxInstances = userSpriteDefinition.maxInstances ?? 1024
        const renderOrder = userSpriteDefinition.renderOrder ?? 0
        const depthWrite = userSpriteDefinition.depthWrite ?? true
        managerInfo = this.getOrCreateInstanceManager(
          resource,
          maxInstances,
          renderOrder,
          depthWrite,
          resolvedMaterialFactory,
        )
        resourceManagers.set(resource, managerInfo)
      }

      const instanceIndex = managerInfo.instanceManager.acquireInstanceSlot()

      const resolvedState: ResolvedAnimationState = {
        imagePath: resource.sheetProperties.imagePath,
        sheetTilesetWidth: resource.sheetProperties.sheetTilesetWidth,
        sheetTilesetHeight: resource.sheetProperties.sheetTilesetHeight,
        sheetNumFrames: resource.sheetProperties.sheetNumFrames,
        animNumFrames: animDef.animNumFrames ?? resource.sheetProperties.sheetNumFrames,
        animFrameOffset: animDef.animFrameOffset ?? 0,
        frameDuration: animDef.frameDuration ?? DEFAULT_FRAME_DURATION,
        loop: animDef.loop ?? true,
        initialFrame: animDef.initialFrame ?? DEFAULT_INITIAL_FRAME,
        flipX: animDef.flipX ?? DEFAULT_FLIP_X,
        flipY: animDef.flipY ?? DEFAULT_FLIP_Y,
        texture: resource.texture,
      }

      animationInstanceParams.push({
        name: animName,
        state: resolvedState,
        resource,
        index: instanceIndex,
        instanceManager: managerInfo.instanceManager,
        frameAttribute: managerInfo.frameAttribute,
        flipAttribute: managerInfo.flipAttribute,
      })
    }

    if (
      !userSpriteDefinition.initialAnimation ||
      !userSpriteDefinition.animations[userSpriteDefinition.initialAnimation]
    ) {
      let found = false
      for (const p of animationInstanceParams) if (p.name === userSpriteDefinition.initialAnimation) found = true
      if (!found) {
        for (const params of animationInstanceParams) {
          params.instanceManager.releaseInstanceSlot(params.index)
        }
        throw new Error(
          `[SpriteAnimator] initialAnimation "${userSpriteDefinition.initialAnimation}" not found or invalid for sprite "${id}".`,
        )
      }
    }
    const tiledSprite = new TiledSprite(id, userSpriteDefinition, this, animationInstanceParams)
    this.instances.set(id, tiledSprite)
    return tiledSprite
  }

  update(deltaTime: number): void {
    for (const sprite of this.instances.values()) {
      sprite.update(deltaTime)
    }
  }

  removeSprite(id: string): void {
    const sprite = this.instances.get(id)
    if (sprite) {
      sprite.destroy()
      this.instances.delete(id)
    }
  }

  removeAllSprites(): void {
    const ids = Array.from(this.instances.keys())
    for (const id of ids) {
      this.removeSprite(id)
    }
  }
}
