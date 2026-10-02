import { BaseRenderable, isTextNodeRenderable, TextNodeRenderable, TextRenderable, Yoga } from "@opentui/core"

type LayoutNodeProvider = {
  getLayoutNode?: () => Yoga.Node
}

type LayoutNodeConstructor = { create?: () => Yoga.Node } | undefined

function getLayoutNodeConstructor(parent?: BaseRenderable): LayoutNodeConstructor {
  const parentLayoutNode = (parent as LayoutNodeProvider | undefined)?.getLayoutNode?.()
  return parentLayoutNode?.constructor as LayoutNodeConstructor
}

function createLayoutSlotYogaNode(parentNodeConstructor?: LayoutNodeConstructor): Yoga.Node {
  return parentNodeConstructor?.create?.() ?? Yoga.default.Node.create()
}

class SlotBaseRenderable extends BaseRenderable {
  constructor(id: string) {
    super({
      id,
    })
  }

  public add(obj: BaseRenderable | unknown, index?: number): number {
    throw new Error("Can't add children on an Slot renderable")
  }

  public getChildren(): BaseRenderable[] {
    return []
  }

  public remove(child: BaseRenderable): void {}

  public insertBefore(obj: BaseRenderable | unknown, anchor: BaseRenderable | unknown): void {
    throw new Error("Can't add children on an Slot renderable")
  }

  public getRenderable(id: string): BaseRenderable | undefined {
    return undefined
  }

  public getChildrenCount(): number {
    return 0
  }

  public requestRender(): void {}

  public findDescendantById(id: string): BaseRenderable | undefined {
    return undefined
  }
}

export class TextSlotRenderable extends TextNodeRenderable {
  protected slotParent?: SlotRenderable
  protected destroyed: boolean = false

  constructor(id: string, parent?: SlotRenderable) {
    super({ id: id })
    this._visible = false
    this.slotParent = parent
  }

  public detachFromSlot(): void {
    this.slotParent = undefined
  }

  public disposeWithoutSlotCascade(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.detachFromSlot()
  }

  public override destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true

    const slotParent = this.slotParent
    this.slotParent = undefined

    this.parent?.remove(this)
    slotParent?.didDestroySlotChild(this)
  }
}

export class LayoutSlotRenderable extends SlotBaseRenderable {
  protected yogaNode: Yoga.Node
  protected slotParent?: SlotRenderable
  protected destroyed: boolean = false
  private yogaNodeConstructor: LayoutNodeConstructor
  private yogaNodeFreed: boolean = false

  constructor(id: string, parent?: SlotRenderable, layoutParent?: BaseRenderable) {
    super(id)

    this._visible = false
    this.slotParent = parent
    this.yogaNodeConstructor = getLayoutNodeConstructor(layoutParent)
    this.yogaNode = createLayoutSlotYogaNode(this.yogaNodeConstructor)
    this.yogaNode.setDisplay(Yoga.Display.None)
  }

  public getLayoutNode(): Yoga.Node {
    return this.yogaNode
  }

  public updateFromLayout() {}

  public updateLayout() {}

  public onRemove() {}

  public isCompatibleWith(layoutParent?: BaseRenderable): boolean {
    return this.yogaNodeConstructor === getLayoutNodeConstructor(layoutParent)
  }

  public detachFromSlot(): void {
    this.slotParent = undefined
  }

  private freeYogaNode(): void {
    if (this.yogaNodeFreed) {
      return
    }

    this.yogaNodeFreed = true

    try {
      this.yogaNode.free()
    } catch {}
  }

  public disposeWithoutSlotCascade(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.detachFromSlot()
    this.freeYogaNode()
  }

  // Parents and the reconciler release children through destroyRecursively().
  public override destroyRecursively(): void {
    this.destroy()
  }

  public override destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true

    const slotParent = this.slotParent
    this.slotParent = undefined

    this.parent?.remove(this)
    this.freeYogaNode()
    slotParent?.didDestroySlotChild(this)
  }
}

export class SlotRenderable extends SlotBaseRenderable {
  protected destroyed: boolean = false
  private readonly layoutNodesByParent = new Map<BaseRenderable, LayoutSlotRenderable>()
  private readonly textNodesByParent = new Map<BaseRenderable, TextSlotRenderable>()
  private layoutNodeCount: number = 0
  private textNodeCount: number = 0

  constructor(id: string) {
    super(id)

    this._visible = false
  }

  public get layoutNode(): LayoutSlotRenderable | undefined {
    return this.getCurrentSlotChild(this.layoutNodesByParent)
  }

  public get textNode(): TextSlotRenderable | undefined {
    return this.getCurrentSlotChild(this.textNodesByParent)
  }

  private isTextSlotParent(parent: BaseRenderable): boolean {
    return isTextNodeRenderable(parent) || parent instanceof TextRenderable
  }

  private getCurrentSlotChild<T extends BaseRenderable>(nodesByParent: Map<BaseRenderable, T>): T | undefined {
    for (const node of nodesByParent.values()) {
      if (node.parent) {
        return node
      }
    }

    return nodesByParent.values().next().value
  }

  private getTextNodeForParent(parent: BaseRenderable): TextSlotRenderable | undefined {
    const mappedNode = this.textNodesByParent.get(parent)
    if (mappedNode) {
      return mappedNode
    }

    for (const [mappedParent, textNode] of this.textNodesByParent) {
      if (textNode.parent !== parent) {
        continue
      }

      this.textNodesByParent.delete(mappedParent)
      this.textNodesByParent.set(parent, textNode)
      return textNode
    }
  }

  private getLayoutNodeForParent(parent: BaseRenderable): LayoutSlotRenderable | undefined {
    const mappedNode = this.layoutNodesByParent.get(parent)
    if (mappedNode) {
      return mappedNode
    }

    for (const [mappedParent, layoutNode] of this.layoutNodesByParent) {
      if (layoutNode.parent !== parent) {
        continue
      }

      this.layoutNodesByParent.delete(mappedParent)
      this.layoutNodesByParent.set(parent, layoutNode)
      return layoutNode
    }
  }

  private takeReusableTextNode(parent: BaseRenderable): TextSlotRenderable | undefined {
    for (const [mappedParent, textNode] of this.textNodesByParent) {
      if (textNode.parent) {
        continue
      }

      this.textNodesByParent.delete(mappedParent)
      this.textNodesByParent.set(parent, textNode)
      return textNode
    }
  }

  private takeReusableLayoutNode(parent: BaseRenderable): LayoutSlotRenderable | undefined {
    for (const [mappedParent, layoutNode] of this.layoutNodesByParent) {
      if (layoutNode.parent) {
        continue
      }

      if (!layoutNode.isCompatibleWith(parent)) {
        continue
      }

      this.layoutNodesByParent.delete(mappedParent)
      this.layoutNodesByParent.set(parent, layoutNode)
      return layoutNode
    }
  }

  private disposeDetachedTextNodes(): void {
    for (const [parent, textNode] of this.textNodesByParent) {
      if (textNode.parent) {
        continue
      }

      this.textNodesByParent.delete(parent)
      textNode.disposeWithoutSlotCascade()
    }
  }

  private disposeDetachedIncompatibleLayoutNodes(parent: BaseRenderable): void {
    for (const [mappedParent, layoutNode] of this.layoutNodesByParent) {
      if (layoutNode.parent || layoutNode.isCompatibleWith(parent)) {
        continue
      }

      this.layoutNodesByParent.delete(mappedParent)
      layoutNode.disposeWithoutSlotCascade()
    }
  }

  // A slot can have multiple placeholder children attached transiently while a
  // move is in flight. Portal host tracking relies on `slot.parent` pointing at
  // one of the still-live hosts, not necessarily the most recently inserted one.
  private getAttachedSlotParent(excludedNode?: BaseRenderable): BaseRenderable | null {
    for (const textNode of this.textNodesByParent.values()) {
      if (textNode !== excludedNode && textNode.parent) {
        return textNode.parent
      }
    }

    for (const layoutNode of this.layoutNodesByParent.values()) {
      if (layoutNode !== excludedNode && layoutNode.parent) {
        return layoutNode.parent
      }
    }

    return null
  }

  private hasOtherAttachedSlotChildren(excludedNode: BaseRenderable): boolean {
    return this.getAttachedSlotParent(excludedNode) !== null
  }

  getSlotChild(parent: BaseRenderable) {
    if (this.isTextSlotParent(parent)) {
      const existingTextNode = this.getTextNodeForParent(parent)
      if (existingTextNode) {
        return existingTextNode
      }

      const reusableTextNode = this.takeReusableTextNode(parent)
      if (reusableTextNode) {
        return reusableTextNode
      }

      this.disposeDetachedIncompatibleLayoutNodes(parent)

      const textNode = new TextSlotRenderable(`slot-text-${this.id}-${++this.textNodeCount}`, this)
      this.textNodesByParent.set(parent, textNode)
      return textNode
    }

    const existingLayoutNode = this.getLayoutNodeForParent(parent)
    if (existingLayoutNode) {
      return existingLayoutNode
    }

    const reusableLayoutNode = this.takeReusableLayoutNode(parent)
    if (reusableLayoutNode) {
      return reusableLayoutNode
    }

    this.disposeDetachedTextNodes()
    this.disposeDetachedIncompatibleLayoutNodes(parent)

    const layoutNode = new LayoutSlotRenderable(`slot-layout-${this.id}-${++this.layoutNodeCount}`, this, parent)
    this.layoutNodesByParent.set(parent, layoutNode)
    return layoutNode
  }

  getSlotChildForRemoval(parent: BaseRenderable): BaseRenderable | undefined {
    if (this.isTextSlotParent(parent)) {
      return this.getTextNodeForParent(parent)
    }

    return this.getLayoutNodeForParent(parent)
  }

  didRemoveSlotChild(parent: BaseRenderable, child: BaseRenderable): void {
    const hasOtherAttachedSlotChildren = this.hasOtherAttachedSlotChildren(child)

    if (
      hasOtherAttachedSlotChildren &&
      child instanceof TextSlotRenderable &&
      this.getTextNodeForParent(parent) === child
    ) {
      this.textNodesByParent.delete(parent)
      child.disposeWithoutSlotCascade()
    }

    if (
      hasOtherAttachedSlotChildren &&
      child instanceof LayoutSlotRenderable &&
      this.getLayoutNodeForParent(parent) === child
    ) {
      this.layoutNodesByParent.delete(parent)
      child.disposeWithoutSlotCascade()
    }

    if (this.parent === parent) {
      this.parent = this.getAttachedSlotParent(child)
    }
  }

  didDestroySlotChild(child: LayoutSlotRenderable | TextSlotRenderable): void {
    const nodesByParent: Map<BaseRenderable, BaseRenderable> =
      child instanceof LayoutSlotRenderable ? this.layoutNodesByParent : this.textNodesByParent
    for (const [parent, node] of nodesByParent) {
      if (node !== child) continue
      nodesByParent.delete(parent)
      if (this.parent === parent) this.parent = this.getAttachedSlotParent()
    }
  }

  public override destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.parent = null

    const layoutNodes = new Set(this.layoutNodesByParent.values())
    this.layoutNodesByParent.clear()
    for (const layoutNode of layoutNodes) {
      layoutNode.destroy()
    }

    const textNodes = new Set(this.textNodesByParent.values())
    this.textNodesByParent.clear()
    for (const textNode of textNodes) {
      textNode.destroy()
    }
  }
}
