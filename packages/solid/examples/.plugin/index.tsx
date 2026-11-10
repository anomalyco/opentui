import { OptimizedBuffer, RGBA, type RenderContext } from "@opentui/core"
import { ThreeRenderable, THREE } from "@opentui/three"
import { extend, type SolidPlugin } from "@opentui/solid"
import { ExternalSidebarPanel, ExternalStatusCard } from "./slot-components.tsx"

export type ExternalPluginSlots = {
  statusbar: { label: string }
  sidebar: { section: string }
}

export type ExternalPluginContext = {
  appName: string
  version: string
}

const CAPABILITIES = ["statusbar extension", "sidebar extension", "external jsx components", "three entrypoint"]

class ExternalCubeRenderable extends ThreeRenderable {
  private cube: THREE.Mesh

  constructor(ctx: RenderContext, options: ConstructorParameters<typeof ThreeRenderable>[1]) {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
    camera.position.set(0, 0, 2.55)
    camera.lookAt(0, 0, 0)

    const ambientLight = new THREE.AmbientLight(new THREE.Color("#666666"), 1.0)
    scene.add(ambientLight)

    const keyLight = new THREE.DirectionalLight(new THREE.Color("#fff2e6"), 1.2)
    keyLight.position.set(2.5, 2.0, 3.0)
    scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(new THREE.Color("#80b3ff"), 0.6)
    fillLight.position.set(-2.0, -1.5, 2.5)
    scene.add(fillLight)

    const cubeGeometry = new THREE.BoxGeometry(1.0, 1.0, 1.0)
    const cubeMaterial = new THREE.MeshPhongMaterial({
      color: new THREE.Color("#40ccff"),
      shininess: 80,
      specular: new THREE.Color("#e6e6ff"),
    })
    const cube = new THREE.Mesh(cubeGeometry, cubeMaterial)
    cube.scale.setScalar(1.12)
    scene.add(cube)

    super(ctx, {
      ...options,
      scene,
      camera,
      renderer: {
        ...(options.renderer ?? {}),
        focalLength: 8,
        alpha: true,
        backgroundColor: RGBA.fromValues(0, 0, 0, 0),
      },
    })

    this.cube = cube
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    const delta = deltaTime / 1000
    this.cube.rotation.x += delta * 0.6
    this.cube.rotation.y += delta * 0.4
    this.cube.rotation.z += delta * 0.2
    super.renderSelf(buffer, deltaTime)
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    external_cube: typeof ExternalCubeRenderable
  }
}

extend({ external_cube: ExternalCubeRenderable })

export function loadExternalPlugin(): SolidPlugin<ExternalPluginSlots, ExternalPluginContext> {
  return {
    id: "external-jsx-plugin",
    order: 20,
    slots: {
      statusbar(ctx, props) {
        return <ExternalStatusCard host={ctx.appName} label={props.label} version={ctx.version} />
      },
      sidebar(_ctx, props) {
        return (
          <box flexDirection="column">
            <ExternalSidebarPanel section={props.section} capabilities={CAPABILITIES} />
            <box marginTop={1} border borderStyle="single" borderColor="#334155" flexDirection="column">
              <text fg="#93c5fd">3D cube from @opentui/three</text>
              <external_cube width="100%" height={16} />
            </box>
          </box>
        )
      },
    },
  }
}
