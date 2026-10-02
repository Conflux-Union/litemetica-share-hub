<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'zhimo-ui'

const emit = defineEmits<{ select: [file: File] }>()

const file = ref<File | null>(null)
const dragging = ref(false)
const inputEl = ref<HTMLInputElement>()

function onDrop(e: DragEvent) {
  dragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) pick(f)
}

function pick(f: File) {
  if (!f.name.toLowerCase().endsWith('.litematic')) {
    toast('仅支持 .litematic 文件', { type: 'error' })
    return
  }
  file.value = f
  emit('select', f)
}

function onInput(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) pick(f)
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}
</script>

<template>
  <div
    class="file-drop"
    :class="{ dragover: dragging, 'has-file': !!file }"
    @click="inputEl?.click()"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <input
      ref="inputEl"
      type="file"
      accept=".litematic"
      style="display: none"
      @change="onInput"
    />
    <template v-if="file">
      <div style="font-weight: 600">{{ file.name }}</div>
      <div class="muted">{{ formatSize(file.size) }} · 点击重新选择</div>
    </template>
    <template v-else>
      <div style="font-size: 1.05rem">拖拽 .litematic 文件到这里，或点击选择</div>
      <div class="muted">Litematica 原理图</div>
    </template>
  </div>
</template>
