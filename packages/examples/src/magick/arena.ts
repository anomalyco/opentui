import * as THREE from "three"

export function createArena(aspect: number) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError("aspect must be positive and finite")
  const particleCount = 512
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111925)
  const height = Math.max(10, 14 / aspect)
  const camera = new THREE.OrthographicCamera(-height * aspect, height * aspect, height, -height, 0.1, 100)
  camera.position.set(24, 24, 24)
  camera.lookAt(0, 0, 0)
  scene.add(new THREE.AmbientLight(0xc4d3ef, 0.9))
  const sun = new THREE.DirectionalLight(0xffefd9, 2)
  sun.position.set(8, 16, 5)
  scene.add(sun)

  const transform = new THREE.Object3D()
  const color = new THREE.Color()
  const floor = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.97, 0.16, 0.97),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    18 * 18,
  )
  for (let i = 0; i < floor.count; i++) {
    const x = i % 18
    const z = Math.floor(i / 18)
    transform.position.set(x - 8.5, -0.08, z - 8.5)
    transform.updateMatrix()
    floor.setMatrixAt(i, transform.matrix)
    floor.setColorAt(i, color.setHex((x + z) % 2 ? 0x39454f : 0x313c46))
  }
  scene.add(floor)
  const pillars = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.65, 0.8, 1, 6),
    new THREE.MeshLambertMaterial({ color: 0x849298, flatShading: true }),
    6,
  )
  const obstacles = [
    [-6, -5],
    [-6, 1],
    [-1, -6],
    [5, -1],
    [0, 4],
    [6, 5],
  ]
  obstacles.forEach(([x, z], i) => {
    const height = 1.2 + (i % 3) * 0.5
    transform.position.set(x, height / 2, z)
    transform.scale.set(1, height, 1)
    transform.updateMatrix()
    pillars.setMatrixAt(i, transform.matrix)
  })
  scene.add(pillars)
  const palette = [0xf05a63, 0x51a8ed, 0x6ed6a3, 0xf4c35d]
  const origins = [
    [-3, -3],
    [3, -3],
    [3, 3],
    [-3, 3],
  ]
  const robe = new THREE.ConeGeometry(0.56, 1.15, 8)
  const head = new THREE.SphereGeometry(0.24, 6, 4)
  const brim = new THREE.CylinderGeometry(0.46, 0.46, 0.08, 8)
  const hat = new THREE.ConeGeometry(0.4, 0.8, 8)
  const staff = new THREE.CylinderGeometry(0.045, 0.045, 1.7, 5)
  const orb = new THREE.IcosahedronGeometry(0.14, 0)
  const skin = new THREE.MeshLambertMaterial({ color: 0xe1bb96, flatShading: true })
  const wood = new THREE.MeshLambertMaterial({ color: 0x6c482e })
  const wizards = palette.map((tint) => {
    const wizard = new THREE.Group()
    const cloth = new THREE.MeshLambertMaterial({ color: tint, flatShading: true })
    for (const [geometry, material, x, y] of [
      [robe, cloth, 0, 0.65],
      [head, skin, 0, 1.37],
      [brim, cloth, 0, 1.56],
      [hat, cloth, 0, 2],
      [staff, wood, 0.7, 0.95],
      [orb, cloth, 0.7, 1.85],
    ] as const) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, 0)
      wizard.add(mesh)
    }
    scene.add(wizard)
    return wizard
  })
  const enemies = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.4, 0),
    new THREE.MeshLambertMaterial({ color: 0xb781cc, flatShading: true }),
    32,
  )
  const particles = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.09, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    particleCount,
  )
  for (let i = 0; i < particleCount; i++) particles.setColorAt(i, color.setHex(palette[i % 4]))
  for (const mesh of [enemies, particles]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
    scene.add(mesh)
  }
  const update = (seconds: number, player?: { x: number; z: number }) => {
    for (let i = 0; i < wizards.length; i++) {
      wizards[i].position.set(
        i === 0 && player ? player.x : origins[i][0],
        0.04 + Math.sin(seconds * 2 + i) * 0.035,
        i === 0 && player ? player.z : origins[i][1],
      )
      wizards[i].rotation.y = seconds * 0.35 + (i * Math.PI) / 2
    }
    transform.scale.set(0.85, 1.2, 0.85)
    for (let i = 0; i < enemies.count; i++) {
      const angle = (i * Math.PI * 2) / enemies.count + seconds * 0.07
      const radius = 7.3 + Math.sin(i * 2.4) * 0.35
      transform.position.set(Math.cos(angle) * radius, 0.5 + Math.sin(seconds * 3 + i) * 0.08, Math.sin(angle) * radius)
      transform.rotation.set(0, -angle, 0)
      transform.updateMatrix()
      enemies.setMatrixAt(i, transform.matrix)
    }
    enemies.instanceMatrix.needsUpdate = true
    transform.rotation.set(0, 0, 0)
    for (let i = 0; i < particleCount; i++) {
      const lane = i % 4
      const phase = (i * 0.61803398875) % 1
      const cycle = seconds * 0.45 + phase
      const age = cycle - Math.floor(cycle)
      const angle = (lane * Math.PI) / 2 + (phase - 0.5) * 0.75 + Math.sin(seconds * 0.45) * 0.2
      const radius = 0.6 + age * 5
      const origin = wizards[lane].position
      transform.position.set(
        origin.x + Math.cos(angle) * radius,
        origin.y + 1.1 + Math.sin(age * Math.PI) * 1.5 + Math.sin(i * 2.4) * 0.2,
        origin.z + Math.sin(angle) * radius,
      )
      transform.scale.setScalar(0.25 + (1 - age) * 1.1)
      transform.updateMatrix()
      particles.setMatrixAt(i, transform.matrix)
    }
    particles.instanceMatrix.needsUpdate = true
  }
  update(0)
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    geometries.add(object.geometry)
    materials.add(object.material as THREE.Material)
  })
  return {
    scene,
    camera,
    update,
    dispose() {
      for (const mesh of [floor, pillars, enemies, particles]) mesh.dispose()
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      geometries.clear()
      materials.clear()
      scene.clear()
    },
  }
}
