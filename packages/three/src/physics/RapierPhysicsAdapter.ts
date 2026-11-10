import type { RigidBody, World } from "@dimforge/rapier2d-simd-compat"
// @ts-expect-error Rapier does not publish types for its ESM subpath.
import * as RAPIER from "@dimforge/rapier2d-simd-compat/rapier.es.js"
import type {
  PhysicsVector2,
  PhysicsRigidBodyDesc,
  PhysicsColliderDesc,
  PhysicsRigidBody,
  PhysicsWorld,
} from "./physics-interface.js"

export class RapierRigidBody implements PhysicsRigidBody {
  constructor(private rapierBody: RigidBody) {}

  applyImpulse(force: PhysicsVector2): void {
    this.rapierBody.applyImpulse(force, true)
  }

  applyTorqueImpulse(torque: number): void {
    this.rapierBody.applyTorqueImpulse(torque, true)
  }

  getTranslation(): PhysicsVector2 {
    const pos = this.rapierBody.translation()
    return { x: pos.x, y: pos.y }
  }

  getRotation(): number {
    return this.rapierBody.rotation()
  }

  get nativeBody(): RigidBody {
    return this.rapierBody
  }
}

export class RapierPhysicsWorld implements PhysicsWorld {
  constructor(private rapierWorld: World) {}

  createRigidBody(desc: PhysicsRigidBodyDesc): PhysicsRigidBody {
    const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(desc.translation.x, desc.translation.y)
      .setLinearDamping(desc.linearDamping)
      .setAngularDamping(desc.angularDamping)

    const rapierBody = this.rapierWorld.createRigidBody(rigidBodyDesc)
    return new RapierRigidBody(rapierBody)
  }

  createCollider(colliderDesc: PhysicsColliderDesc, rigidBody: PhysicsRigidBody): void {
    const rapierColliderDesc = RAPIER.ColliderDesc.cuboid(colliderDesc.width * 0.5, colliderDesc.height * 0.5)
      .setRestitution(colliderDesc.restitution)
      .setFriction(colliderDesc.friction)
      .setDensity(colliderDesc.density)

    const rapierRigidBody = (rigidBody as RapierRigidBody).nativeBody
    this.rapierWorld.createCollider(rapierColliderDesc, rapierRigidBody)
  }

  removeRigidBody(rigidBody: PhysicsRigidBody): void {
    const rapierRigidBody = (rigidBody as RapierRigidBody).nativeBody
    this.rapierWorld.removeRigidBody(rapierRigidBody)
  }

  static createFromRapierWorld(rapierWorld: World): RapierPhysicsWorld {
    return new RapierPhysicsWorld(rapierWorld)
  }
}
