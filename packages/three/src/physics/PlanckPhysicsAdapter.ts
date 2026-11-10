import * as planck from "planck"
import type {
  PhysicsVector2,
  PhysicsRigidBodyDesc,
  PhysicsColliderDesc,
  PhysicsRigidBody,
  PhysicsWorld,
} from "./physics-interface.js"

export class PlanckRigidBody implements PhysicsRigidBody {
  constructor(private planckBody: planck.Body) {}

  applyImpulse(force: PhysicsVector2): void {
    this.planckBody.applyLinearImpulse(planck.Vec2(force.x, force.y), this.planckBody.getWorldCenter())
  }

  applyTorqueImpulse(torque: number): void {
    this.planckBody.applyAngularImpulse(torque)
  }

  getTranslation(): PhysicsVector2 {
    const pos = this.planckBody.getPosition()
    return { x: pos.x, y: pos.y }
  }

  getRotation(): number {
    return this.planckBody.getAngle()
  }

  get nativeBody(): planck.Body {
    return this.planckBody
  }
}

export class PlanckPhysicsWorld implements PhysicsWorld {
  constructor(private planckWorld: planck.World) {}

  createRigidBody(desc: PhysicsRigidBodyDesc): PhysicsRigidBody {
    const bodyDef: planck.BodyDef = {
      type: "dynamic",
      position: planck.Vec2(desc.translation.x, desc.translation.y),
      linearDamping: desc.linearDamping,
      angularDamping: desc.angularDamping,
    }

    const planckBody = this.planckWorld.createBody(bodyDef)
    return new PlanckRigidBody(planckBody)
  }

  createCollider(colliderDesc: PhysicsColliderDesc, rigidBody: PhysicsRigidBody): void {
    const shape = planck.Box(colliderDesc.width * 0.5, colliderDesc.height * 0.5)

    const fixtureDef: planck.FixtureDef = {
      shape: shape,
      density: colliderDesc.density,
      friction: colliderDesc.friction,
      restitution: colliderDesc.restitution,
    }

    const planckRigidBody = (rigidBody as PlanckRigidBody).nativeBody
    planckRigidBody.createFixture(fixtureDef)
  }

  removeRigidBody(rigidBody: PhysicsRigidBody): void {
    const planckRigidBody = (rigidBody as PlanckRigidBody).nativeBody
    this.planckWorld.destroyBody(planckRigidBody)
  }

  static createFromPlanckWorld(planckWorld: planck.World): PlanckPhysicsWorld {
    return new PlanckPhysicsWorld(planckWorld)
  }
}
