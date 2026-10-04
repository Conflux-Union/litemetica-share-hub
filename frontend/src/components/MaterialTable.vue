<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MaterialEntry } from '../types'
import { loadAssets } from '../render/assets'
import { blockIconDataURL } from '../render/icon'
import { blockColorHex } from '../render/colors'

const props = defineProps<{ materials: MaterialEntry[] }>()

const search = ref('')
const sortKey = ref<'count' | 'name'>('count')

const rows = computed(() => {
  const q = search.value.trim().toLowerCase()
  const filtered = q
    ? props.materials.filter(
        (m) =>
          m.name_zh.toLowerCase().includes(q) || m.item_id.toLowerCase().includes(q),
      )
    : props.materials
  return [...filtered].sort((a, b) =>
    sortKey.value === 'count'
      ? b.count - a.count || a.item_id.localeCompare(b.item_id)
      : a.item_id.localeCompare(b.item_id),
  )
})

const total = computed(() => props.materials.reduce((s, m) => s + m.count, 0))

// Block icons: inventory-style isometric renders of each block's model
// (render/icon), or flat colors as fallback.
const iconUrls = ref(new Map<string, string>())

onMounted(async () => {
  const store = await loadAssets()
  if (!store) return
  const out = new Map<string, string>()
  for (const m of props.materials) {
    const url = blockIconDataURL(store, m.item_id, 64)
    if (url) out.set(m.item_id, url)
  }
  iconUrls.value = out
})

watch(
  () => props.materials,
  () => {
    iconUrls.value = new Map()
  },
)

function icon(m: MaterialEntry): { url?: string; color?: string } {
  const url = iconUrls.value.get(m.item_id)
  if (url) return { url }
  return { color: blockColorHex(m.item_id) }
}
</script>

<template>
  <div>
    <div class="toolbar">
      <zhimo-input
        placeholder="搜索材料…"
        :value="search"
        style="max-width: 240px"
        @input="search = $event.target.value"
      ></zhimo-input>
      <span class="spacer"></span>
      <span class="muted">{{ rows.length }} 种材料 · 共 {{ total.toLocaleString() }} 个方块</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width: 36px"></th>
          <th @click="sortKey = 'name'">材料</th>
          <th @click="sortKey = 'name'">ID</th>
          <th @click="sortKey = 'count'" style="text-align: right">数量</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in rows" :key="m.item_id">
          <td>
            <span
              class="block-icon"
              :style="icon(m).url ? { backgroundImage: `url(${icon(m).url})` } : { background: icon(m).color }"
            ></span>
          </td>
          <td>{{ m.name_zh }}</td>
          <td class="muted">{{ m.item_id.replace('minecraft:', '') }}</td>
          <td style="text-align: right; font-variant-numeric: tabular-nums">
            {{ m.count.toLocaleString() }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
