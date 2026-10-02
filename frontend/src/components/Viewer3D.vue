<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { api, ApiError } from '../api'
import { loadAtlas } from '../render/atlas'
import { blockColor } from '../render/colors'
import { decodePreview } from '../render/decode'
import { extractSurface } from '../render/surface'

const props = defineProps<{ schematicId: string }>()

const container = ref<HTMLDivElement>()
const status = ref('加载中…')
const faceCount = ref(0)

let dispose: (() => void) | null = null

async function render() {
  if (!container.value) return
  status.value = '加载中…'
  faceCount.value = 0

  const width = container.value.clientWidth
  const height = container.value.clientHeight

  // 1. Fetch + decode the RLE preview data.
  const resp = await fetch(api.previewUrl(props.schematicId))
  if (!resp.ok) throw new ApiError(resp.status, '预览数据加载失败')
  const gz = new Uint8Array(await resp.arrayBuffer())
  const grid = decodePreview(gz)

  // 2. Resolve textures: extracted atlas first, flat colors as fallback.
  const atlas = await loadAtlas()
  const resolveUv = atlas ? atlas.resolveUv : () => null

  // 3. Extract visible surfaces (hidden faces culled, AO baked into colors).
  const mesh = extractSurface(grid, resolveUv)
  faceCount.value = mesh.faceCount

  // 4. Build the three.js scene.
  const scene = new THREE.Scene()
  const applyBackground = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    scene.background = new THREE.Color(dark ? 0x211d18 : 0xf1ece0)
  }
  applyBackground()

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 10000)
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  container.value.appendChild(renderer.domElement)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
  geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3))
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))

  if (atlas) {
    const mat = new THREE.MeshLambertMaterial({ map: atlas.texture, vertexColors: true })
    const matT = new THREE.MeshLambertMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
    })
    // Opaque faces only; transparent faces render from a separate geometry.
    const opaque = new THREE.Mesh(geometry, mat)
    opaque.geometry.setDrawRange(0, mesh.opaqueIndexCount)
    scene.add(opaque)
    const alpha = new THREE.BufferGeometry()
    alpha.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    alpha.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
    alpha.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
    alpha.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3))
    alpha.setIndex(
      new THREE.BufferAttribute(mesh.indices.subarray(mesh.opaqueIndexCount), 1),
    )
    scene.add(new THREE.Mesh(alpha, matT))
  } else {
    // Flat-color fallback: bake block color into vertex colors.
    const colors = new Float32Array(mesh.colors.length)
    const [dx, , dz] = grid.dims
    const voxColors = grid.palette.map((id) => blockColor(id))
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      // Recover the voxel for this vertex to pick its color.
      const x = Math.floor(mesh.positions[i * 3])
      const y = Math.floor(mesh.positions[i * 3 + 1])
      const z = Math.floor(mesh.positions[i * 3 + 2])
      const ci = y * dz * dx + z * dx + x
      const idx = ci >= 0 && ci < grid.data.length ? grid.data[ci] : 0
      const c = voxColors[idx] ?? [1, 1, 1]
      const light = mesh.colors[i * 3]
      colors[i * 3] = c[0] * light
      colors[i * 3 + 1] = c[1] * light
      colors[i * 3 + 2] = c[2] * light
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
    const matT = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    })
    const opaqueMesh = new THREE.Mesh(geometry, mat)
    opaqueMesh.geometry.setDrawRange(0, mesh.opaqueIndexCount)
    scene.add(opaqueMesh)
    const alpha = new THREE.BufferGeometry()
    alpha.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    alpha.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
    alpha.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    alpha.setIndex(new THREE.BufferAttribute(mesh.indices.subarray(mesh.opaqueIndexCount), 1))
    scene.add(new THREE.Mesh(alpha, matT))
  }

  const hemi = new THREE.HemisphereLight(0xffffff, 0x888877, 1.15)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 0.9)
  dir.position.set(1, 2, 0.5)
  scene.add(dir)

  // 5. Frame the schematic: center the bounding box and step back.
  const [dx, dy, dz] = grid.dims
  const center = new THREE.Vector3(dx / 2, dy / 2, dz / 2)
  const radius = Math.max(dx, dy, dz) / 2 || 1
  camera.position.set(
    center.x + radius * 1.6,
    center.y + radius * 1.3,
    center.z + radius * 1.6,
  )
  camera.lookAt(center)
  camera.near = radius / 100
  camera.far = radius * 100
  camera.updateProjectionMatrix()

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(center)
  controls.enableDamping = true
  controls.update()

  let raf = 0
  const tick = () => {
    controls.update()
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  tick()

  const ro = new ResizeObserver(() => {
    const w = container.value?.clientWidth ?? width
    const h = container.value?.clientHeight ?? height
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  })
  ro.observe(container.value)

  const themeObserver = new MutationObserver(applyBackground)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })

  status.value = ''
  dispose = () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
    themeObserver.disconnect()
    controls.dispose()
    geometry.dispose()
    renderer.dispose()
    renderer.domElement.remove()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
    })
  }
}

onMounted(async () => {
  try {
    await render()
  } catch (e) {
    status.value = e instanceof Error ? e.message : '预览渲染失败'
  }
})

watch(
  () => props.schematicId,
  async () => {
    dispose?.()
    dispose = null
    try {
      await render()
    } catch (e) {
      status.value = e instanceof Error ? e.message : '预览渲染失败'
    }
  },
)

onBeforeUnmount(() => {
  dispose?.()
  dispose = null
})
</script>

<template>
  <div class="viewer-shell">
    <div ref="container" style="width: 100%; height: 100%"></div>
    <div v-if="status" class="viewer-tip" style="left: 50%; transform: translateX(-50%)">
      <zhimo-spinner v-if="status === '加载中…'" style="vertical-align: -3px" />
      {{ status }}
    </div>
    <div v-else class="viewer-tip">拖拽旋转 · 滚轮缩放 · 右键平移</div>
  </div>
</template>
