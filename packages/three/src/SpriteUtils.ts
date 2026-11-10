import { TextureUtils } from "./TextureUtils.js"
import { Sprite, SpriteMaterial, DataTexture, type SpriteMaterialParameters } from "three"

export class SheetSprite extends Sprite {
  private _frameIndex: number = 0
  private _numFrames: number = 0

  constructor(material: SpriteMaterial, numFrames: number) {
    super(material)
    this._numFrames = numFrames
    this.setIndex(0)
  }

  setIndex = (index: number) => {
    this._frameIndex = index
    this.material.map?.repeat.set(1 / this._numFrames, 1)
    this.material.map?.offset.set(this._frameIndex / this._numFrames, 0)
  }
}

export class SpriteUtils {
  static async fromFile(
    path: string,
    {
      materialParameters = {
        alphaTest: 0.1,
        depthWrite: true,
      },
    }: {
      materialParameters?: Omit<SpriteMaterialParameters, "map">
    } = {},
  ): Promise<Sprite> {
    const texture = await TextureUtils.fromFile(path)
    if (!texture) {
      throw new Error(`Failed to load sprite texture from ${path}`)
    }

    const spriteMaterial = new SpriteMaterial({ map: texture, ...materialParameters })
    const sprite = new Sprite(spriteMaterial)

    const textureAspectRatio = texture.image.width / texture.image.height

    sprite.updateMatrix = function () {
      this.matrix.compose(this.position, this.quaternion, this.scale.clone().setX(this.scale.x * textureAspectRatio))
    }

    return sprite
  }

  static async sheetFromFile(path: string, numFrames: number): Promise<SheetSprite> {
    const spriteTexture = await TextureUtils.fromFile(path)

    if (!spriteTexture) {
      throw new Error(`Failed to load sprite texture from ${path}`)
    }

    const spriteMaterial = new SpriteMaterial({ map: spriteTexture })
    const sprite = new SheetSprite(spriteMaterial, numFrames)

    const singleFrameWidth = spriteTexture.image.width / numFrames
    const singleFrameHeight = spriteTexture.image.height
    const frameAspectRatio = singleFrameWidth / singleFrameHeight

    sprite.updateMatrix = function () {
      this.matrix.compose(this.position, this.quaternion, this.scale.clone().setX(this.scale.x * frameAspectRatio))
    }

    return sprite
  }
}
