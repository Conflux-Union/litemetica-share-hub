<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { api, ApiError } from '../api'
import { loadAssets } from '../render/assets'
import { decodePreview } from '../render/decode'
import { extractSurface, type MeshData } from '../render/surface'
import BrandLoader from './BrandLoader.vue'

const props = defineProps<{ schematicId: string }>()

const container = ref<HTMLDivElement>()
const loading = ref(true)
const error = ref('')
const faceCount = ref(0)

let dispose: (() => void) | null = null

/** Geometry for one draw range, sharing the merged attribute arrays. */
function rangeGeometry(mesh: MeshData, range: { start: number; count: number }): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
  geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3))
  geometry.setIndex(
    new THREE.BufferAttribute(mesh.indices.subarray(range.start, range.start + range.count), 1),
  )
  return geometry
}

async function render() {
  if (!container.value) return
  loading.value = true
  error.value = ''
  faceCount.value = 0

  const width = container.value.clientWidth
  const height = container.value.clientHeight

  // 1. Fetch + decode the RLE preview data.
  const resp = await fetch(api.previewUrl(props.schematicId))
  if (!resp.ok) throw new ApiError(resp.status, '预览数据加载失败')
  const gz = new Uint8Array(await resp.arrayBuffer())
  const grid = decodePreview(gz)

  // 2. Resolve the render bundle (null keeps the flat-color fallback).
  const store = await loadAssets()

  // 3. Mesh: vanilla model quads with cull groups, AO and tint baked into
  //    vertex colors; opaque / cutout / translucent / flat draw ranges.
  const mesh = extractSurface(grid, store)
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

  const materials: THREE.Material[] = []
  const addMesh = (range: { start: number; count: number }, material: THREE.Material) => {
    if (!range.count) {
      material.dispose()
      return
    }
    materials.push(material)
    scene.add(new THREE.Mesh(rangeGeometry(mesh, range), material))
  }

  if (store) {
    // Three render passes by alpha class, plus the untextured placeholder
    // pass. Cutout stays z-buffered via alphaTest; translucents blend last.
    addMesh(
      mesh.ranges.opaque,
      new THREE.MeshLambertMaterial({ map: store.texture, vertexColors: true }),
    )
    addMesh(
      mesh.ranges.cutout,
      new THREE.MeshLambertMaterial({ map: store.texture, vertexColors: true, alphaTest: 0.5 }),
    )
    addMesh(
      mesh.ranges.translucent,
      new THREE.MeshLambertMaterial({
        map: store.texture,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    addMesh(mesh.ranges.flat, new THREE.MeshLambertMaterial({ vertexColors: true }))
  } else {
    // Flat-color fallback: block colors are already baked into vertices.
    addMesh(
      mesh.ranges.flat,
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    )
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

  loading.value = false
  dispose = () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
    themeObserver.disconnect()
    controls.dispose()
    for (const material of materials) material.dispose()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
    })
    renderer.dispose()
    renderer.domElement.remove()
  }
}

onMounted(async () => {
  try {
    await render()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '预览渲染失败'
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
      error.value = e instanceof Error ? e.message : '预览渲染失败'
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
    <div v-if="loading" class="viewer-overlay">
      <BrandLoader />
    </div>
    <div v-else-if="error" class="viewer-overlay viewer-error">{{ error }}</div>
    <div v-else class="viewer-tip">拖拽旋转 · 滚轮缩放 · 右键平移</div>
  </div>
</template>

<style scoped>
/* Centered states over the viewer canvas: brand loader while fetching,
   error message on failure. Semi-opaque paper veil covers re-renders. */
.viewer-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--zhimo-bg, #faf7f0) 72%, transparent);
}

.viewer-error {
  color: var(--zhimo-danger, #9e2f1c);
  font-size: 0.95rem;
}
</style>
