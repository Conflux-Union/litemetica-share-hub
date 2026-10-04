<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { api, ApiError } from '../api'
import { atlasTileSpan, loadAssets } from '../render/assets'
import {
  asMeshResponse,
  buildMeshRequest,
  runMeshPipeline,
  LOD_NOTICE,
  type MeshData,
  type MeshResult,
} from '../render/meshWorker'
import { lodLevelForDistance, type LodLevel } from '../render/lod'
import type { AssetBundle } from '../types'
import { applyTiledAtlas } from '../render/tiledMaterial'
import BrandLoader from './BrandLoader.vue'

const props = defineProps<{ schematicId: string }>()

const container = ref<HTMLDivElement>()
const loading = ref(true)
const error = ref('')
const faceCount = ref(0)
/** 0..1 decode+mesh fraction while loading; null shows the plain loader. */
const progress = ref<number | null>(null)
/** Degraded-render notice pinned above the canvas ('' hides it). */
const notice = ref('')

let dispose: (() => void) | null = null
/** Live mesh worker, if one is mid-flight (terminated on dispose). */
let activeWorker: Worker | null = null
/** Bumped by every render start and every stop: an in-flight render whose
 * captured epoch no longer matches was superseded (schematic switch,
 * unmount) and must die quietly instead of falling back inline. */
let renderEpoch = 0

/** The worker infrastructure failed (construction, onerror, stall) and the
 * caller must retry inline. Pipeline errors — the OOM guardrails — are
 * ordinary Errors and never take the fallback, which would re-run the
 * doomed pipeline on the main thread. */
class WorkerUnavailable extends Error {}

/** Render superseded (unmount / schematic switch) — dropped silently. */
class RenderSuperseded extends Error {}

/** No worker message (progress included) for this long → assume the worker
 * is wedged and fall back to the main thread. Progress arrives at
 * per-slice/per-y-layer granularity, so a healthy pipeline ticks far
 * inside this budget; the timeout mainly guards module-load failures. */
const WORKER_STALL_MS = 30_000

/** Geometry for one draw range, sharing the merged attribute arrays. */
function rangeGeometry(mesh: MeshData, range: { start: number; count: number }): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
  // Local texel-space uvs pair with the per-vertex tile origin; the
  // patched materials wrap them into the atlas per fragment.
  geometry.setAttribute('tileOrigin', new THREE.BufferAttribute(mesh.tileOrigins, 2))
  geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3))
  geometry.setIndex(
    new THREE.BufferAttribute(mesh.indices.subarray(range.start, range.start + range.count), 1),
  )
  return geometry
}

/** Decode + mesh in the worker. Resolves with the transferred mesh;
 * rejects with WorkerUnavailable when the worker path cannot be trusted,
 * or with the pipeline's own Error (guardrails) for the error overlay. */
function meshViaWorker(
  gz: ArrayBuffer,
  bundle: AssetBundle | null,
  onProgress: (pct: number) => void,
): Promise<MeshResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../render/meshWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      reject(new WorkerUnavailable('mesh worker construction failed'))
      return
    }
    activeWorker = worker
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      worker.terminate() // one-shot worker: done, errored or wedged alike
      if (activeWorker === worker) activeWorker = null
      outcome()
    }
    const fail = (err: Error): void => settle(() => reject(err))
    const armWatchdog = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => fail(new WorkerUnavailable('mesh worker stalled')), WORKER_STALL_MS)
    }
    worker.onerror = () => fail(new WorkerUnavailable('mesh worker failed'))
    worker.onmessage = (event: MessageEvent) => {
      const msg = asMeshResponse(event.data)
      if (!msg) return
      if (msg.type === 'progress') {
        onProgress(msg.pct)
        armWatchdog()
      } else if (msg.type === 'done') {
        settle(() =>
          resolve({
            mesh: msg.mesh,
            dims: msg.dims,
            coarse: msg.coarse,
            degraded: msg.degraded,
            notice: msg.notice,
          }),
        )
      } else {
        fail(new Error(msg.message))
      }
    }
    armWatchdog()
    // The payload stays cloned (fixtures are KBs–MBs); no input transfer,
    // so the inline fallback below still owns its copy after a failure.
    worker.postMessage(buildMeshRequest(gz, bundle))
  })
}

/** Worker first; on infrastructure failure run the identical pipeline
 * inline. Progress may restart from a lower percentage — it is an honest
 * re-run, not a continuation. Superseded renders never re-run at all. */
async function meshWithFallback(
  gz: ArrayBuffer,
  bundle: AssetBundle | null,
  onProgress: (pct: number) => void,
  stale: () => boolean,
): Promise<MeshResult> {
  try {
    return await meshViaWorker(gz, bundle, onProgress)
  } catch (e) {
    if (!(e instanceof WorkerUnavailable)) throw e
    if (stale()) throw new RenderSuperseded()
    return runMeshPipeline(gz, bundle, onProgress)
  }
}

async function render() {
  if (!container.value) return
  const epoch = ++renderEpoch
  const stale = (): boolean => epoch !== renderEpoch
  loading.value = true
  error.value = ''
  faceCount.value = 0
  progress.value = null
  notice.value = ''

  try {
    await renderCurrent(stale)
  } catch (e) {
    // Superseded renders die quietly: a newer cycle owns the UI state.
    // Anything else clears the loader so the error overlay is reachable —
    // guardrail messages included.
    if (!stale()) {
      error.value = e instanceof Error ? e.message : '预览渲染失败'
      loading.value = false
    }
  }
}

async function renderCurrent(stale: () => boolean): Promise<void> {
  const host = container.value
  if (!host) return
  const width = host.clientWidth
  const height = host.clientHeight

  // 1. Fetch the gzipped RLE preview data.
  const resp = await fetch(api.previewUrl(props.schematicId))
  if (!resp.ok) throw new ApiError(resp.status, '预览数据加载失败')
  if (stale()) throw new RenderSuperseded()
  const gz = await resp.arrayBuffer()

  // 2. Resolve the render bundle (null keeps the flat-color fallback);
  //    the main thread still loads the atlas texture for the materials.
  const store = await loadAssets()
  if (stale()) throw new RenderSuperseded()

  // 3. Decode + mesh off the main thread (inline fallback on worker
  //    failure); vanilla model quads with cull groups, AO and tint baked
  //    into vertex colors; opaque / cutout / translucent / flat ranges.
  //    `coarse` is the distance-LOD mesh; `degraded` means a budget
  //    fallback — the box-proxy tier (textured whole-block approximation)
  //    or the coarse mesh replacing the render.
  const { mesh, dims, coarse, degraded, notice: pipelineNotice } = await meshWithFallback(
    gz,
    store?.bundle ?? null,
    (pct) => {
      progress.value = pct
    },
    stale,
  )
  if (stale()) throw new RenderSuperseded()
  faceCount.value = mesh.faceCount
  notice.value = degraded ? (pipelineNotice ?? LOD_NOTICE) : ''

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
  host.appendChild(renderer.domElement)

  const materials: THREE.Material[] = []
  /** Full-precision level meshes — hidden as one group when the coarse
   * level takes over. */
  const fullMeshes: THREE.Mesh[] = []
  const addMesh = (range: { start: number; count: number }, material: THREE.Material) => {
    if (!range.count) {
      material.dispose()
      return
    }
    materials.push(material)
    const entry = new THREE.Mesh(rangeGeometry(mesh, range), material)
    fullMeshes.push(entry)
    scene.add(entry)
  }

  if (store) {
    // Three render passes by alpha class, plus the untextured placeholder
    // pass. Cutout stays z-buffered via alphaTest; translucents blend last.
    // Textured passes sample the gutterless atlas through the tiled-UV
    // patch (local 0..16 texel uvs + per-vertex tile origin).
    const span = atlasTileSpan(store.bundle)
    const textured = (opts: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial => {
      const material = new THREE.MeshLambertMaterial({ map: store.texture, vertexColors: true, ...opts })
      applyTiledAtlas(material, span)
      return material
    }
    addMesh(mesh.ranges.opaque, textured({}))
    addMesh(mesh.ranges.cutout, textured({ alphaTest: 0.5 }))
    addMesh(
      mesh.ranges.translucent,
      textured({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    )
    addMesh(mesh.ranges.flat, new THREE.MeshLambertMaterial({ vertexColors: true }))
  } else {
    // Flat-color fallback: block colors are already baked into vertices.
    addMesh(
      mesh.ranges.flat,
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    )
  }

  // Coarse LOD level (distance switching): untextured flat material over
  // the downsampled grid's baked colors; hidden until the camera pulls
  // back past the enter threshold.
  const coarseMeshes: THREE.Mesh[] = []
  if (coarse) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true })
    if (coarse.ranges.flat.count) {
      materials.push(material)
      const entry = new THREE.Mesh(rangeGeometry(coarse, coarse.ranges.flat), material)
      entry.visible = false
      coarseMeshes.push(entry)
      scene.add(entry)
    } else {
      material.dispose()
    }
  }

  const hemi = new THREE.HemisphereLight(0xffffff, 0x888877, 1.15)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 0.9)
  dir.position.set(1, 2, 0.5)
  scene.add(dir)

  // 5. Frame the schematic: center the bounding box and step back.
  const [dx, dy, dz] = dims
  const center = new THREE.Vector3(dx / 2, dy / 2, dz / 2)
  const radius = Math.max(dx, dy, dz) / 2 || 1
  /** Bounding-sphere radius (half the diagonal) — the unit the LOD switch
   * thresholds are expressed in. */
  const lodRadius = Math.hypot(dx, dy, dz) / 2 || 1
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

  // Level switch per frame: distance to the orbit target versus the
  // bounding-sphere radius, with hysteresis (render/lod) so the border
  // never flickers between the two meshes.
  let raf = 0
  let level: LodLevel = 'full'
  const tick = () => {
    controls.update()
    if (coarseMeshes.length > 0) {
      level = lodLevelForDistance(camera.position.distanceTo(controls.target), lodRadius, level)
      const coarseShown = level === 'coarse'
      for (const entry of coarseMeshes) entry.visible = coarseShown
      for (const entry of fullMeshes) entry.visible = !coarseShown
    }
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
  ro.observe(host)

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

/** Tear down one render cycle: scene resources plus any in-flight worker.
 * Invalidates the epoch so superseded renders die instead of falling
 * back inline. */
function stopRender(): void {
  renderEpoch++
  activeWorker?.terminate()
  activeWorker = null
  dispose?.()
  dispose = null
}

/** render() owns its failure handling (see its catch): superseded cycles
 * are silent, everything else clears the loader and reaches the overlay. */
onMounted(() => {
  void render()
})

watch(
  () => props.schematicId,
  () => {
    stopRender()
    void render()
  },
)

onBeforeUnmount(stopRender)
</script>

<template>
  <div class="viewer-shell">
    <div ref="container" style="width: 100%; height: 100%"></div>
    <div v-if="loading" class="viewer-overlay">
      <BrandLoader :text="progress !== null ? `加载中… ${Math.round(progress * 100)}%` : undefined" />
    </div>
    <div v-else-if="error" class="viewer-overlay viewer-error">{{ error }}</div>
    <div v-else class="viewer-tip">拖拽旋转 · 滚轮缩放 · 右键平移</div>
    <div v-if="notice && !loading && !error" class="viewer-notice">{{ notice }}</div>
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

/* Degraded-render notice pinned above the canvas — same paper-pill
   vocabulary as the tip/overlay, pointer-transparent so the orbit
   controls underneath keep working. */
.viewer-notice {
  position: absolute;
  top: 0.6rem;
  left: 50%;
  transform: translateX(-50%);
  font-size: 0.78rem;
  color: var(--zhimo-fg-muted, #968d7c);
  background: color-mix(in srgb, var(--zhimo-bg, #faf7f0) 78%, transparent);
  padding: 0.15rem 0.6rem;
  border-radius: var(--zhimo-radius-sm, 2px);
  pointer-events: none;
  white-space: nowrap;
}
</style>
