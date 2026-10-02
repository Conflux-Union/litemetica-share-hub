<script setup lang="ts">
import type { SchematicSummary } from '../types'

defineProps<{ schematic: SchematicSummary }>()

function formatBlocks(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('zh-CN')
}
</script>

<template>
  <zhimo-card>
    <div slot="header" style="display: flex; align-items: baseline; gap: 0.5rem">
      <router-link
        :to="`/schematics/${schematic.id}`"
        style="font-weight: 700; font-size: 1.02rem; color: inherit; text-decoration: none"
      >
        {{ schematic.name }}
      </router-link>
    </div>
    <div class="muted" style="margin-bottom: 0.6rem; min-height: 2.4em">
      {{ schematic.description || '（无描述）' }}
    </div>
    <div style="display: flex; flex-wrap: wrap; gap: 0.4rem 0.9rem; font-size: 0.82rem">
      <span>📦 {{ formatBlocks(schematic.total_blocks) }} 方块</span>
      <span>📐 {{ schematic.width }}×{{ schematic.height }}×{{ schematic.depth }}</span>
      <span>🎮 {{ schematic.mc_version_name }}</span>
      <span>👤 {{ schematic.author || schematic.uploader }}</span>
      <span class="muted">{{ formatDate(schematic.created_at) }}</span>
    </div>
  </zhimo-card>
</template>
