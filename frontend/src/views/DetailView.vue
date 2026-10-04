<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from 'zhimo-ui'
import { api, ApiError } from '../api'
import { boolAttr } from '../compat'
import { useAuth } from '../auth'
import type { SchematicDetail } from '../types'
import MaterialTable from '../components/MaterialTable.vue'
import Viewer3D from '../components/Viewer3D.vue'
import BrandLoader from '../components/BrandLoader.vue'

const props = defineProps<{ id: string }>()
const { state, load } = useAuth()

const detail = ref<SchematicDetail | null>(null)
const error = ref('')
const downloading = ref(false)
const confirmModal = ref()
const activeTab = ref(0)

onMounted(async () => {
  await load()
  try {
    detail.value = await api.detail(props.id)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '加载失败'
  }
})

async function download() {
  if (!detail.value || downloading.value) return
  downloading.value = true
  try {
    const resp = await fetch(api.downloadUrl(props.id))
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: `下载失败 (${resp.status})` }))
      throw new Error(body.error)
    }
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${detail.value.name}.litematic`
    a.click()
    URL.revokeObjectURL(url)
    // Refresh the anonymous quota shown next to the button.
    if (!state.user) {
      detail.value = await api.detail(props.id)
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : '下载失败', { type: 'error' })
  } finally {
    downloading.value = false
  }
}

async function remove() {
  confirmModal.value?.close()
  try {
    await api.remove(props.id)
    location.href = '/'
  } catch (e) {
    toast(e instanceof ApiError ? e.message : '删除失败', { type: 'error' })
  }
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function quotaHint(): string {
  if (state.user) return '登录用户不限下载'
  const remaining = detail.value?.download_remaining
  if (remaining === null || remaining === undefined) return ''
  return `匿名剩余额度：${remaining} 次`
}
</script>

<template>
  <div class="page">
    <div v-if="error" class="auth-panel">
      <p>{{ error }}</p>
      <zhimo-button variant="secondary" @click="$router.push('/')">返回列表</zhimo-button>
    </div>

    <div v-else-if="!detail" class="page-loader">
      <BrandLoader />
    </div>

    <template v-else>
      <div class="toolbar">
        <h2 style="margin: 0; flex: 1">{{ detail.name }}</h2>
        <span class="muted" style="align-self: center">{{ quotaHint() }}</span>
        <zhimo-button :loading="boolAttr(downloading)" @click="download">下载</zhimo-button>
        <zhimo-button v-if="detail.can_delete" variant="danger" @click="confirmModal?.show()">
          删除
        </zhimo-button>
      </div>

      <Viewer3D :schematic-id="id" />

      <zhimo-tabs style="margin-top: 1.25rem" :active="activeTab">
        <zhimo-tab label="材料列表">
          <div style="padding: 1rem 0">
            <MaterialTable :materials="detail.materials" />
          </div>
        </zhimo-tab>
        <zhimo-tab label="详细信息">
          <div style="padding: 1rem 0">
            <div class="meta-grid">
              <div class="meta-item">
                <div class="label">Minecraft 版本</div>
                <div class="value">{{ detail.mc_version_name }}</div>
              </div>
              <div class="meta-item">
                <div class="label">DataVersion</div>
                <div class="value">{{ detail.mc_data_version }}</div>
              </div>
              <div class="meta-item">
                <div class="label">Litematica 格式版本</div>
                <div class="value">{{ detail.litematica_version }}</div>
              </div>
              <div class="meta-item">
                <div class="label">尺寸 (X×Y×Z)</div>
                <div class="value">{{ detail.width }} × {{ detail.height }} × {{ detail.depth }}</div>
              </div>
              <div class="meta-item">
                <div class="label">方块总数</div>
                <div class="value">{{ detail.total_blocks.toLocaleString() }}</div>
              </div>
              <div class="meta-item">
                <div class="label">区域数</div>
                <div class="value">{{ detail.region_count }}</div>
              </div>
              <div class="meta-item">
                <div class="label">文件大小</div>
                <div class="value">{{ formatSize(detail.size_bytes) }}</div>
              </div>
              <div class="meta-item">
                <div class="label">作者</div>
                <div class="value">{{ detail.author || '—' }}</div>
              </div>
              <div class="meta-item">
                <div class="label">上传者</div>
                <div class="value">{{ detail.uploader }}</div>
              </div>
              <div class="meta-item">
                <div class="label">上传时间</div>
                <div class="value">
                  {{ new Date(detail.created_at * 1000).toLocaleString('zh-CN') }}
                </div>
              </div>
            </div>
            <p v-if="detail.description" style="line-height: 1.7; white-space: pre-wrap">
              {{ detail.description }}
            </p>
          </div>
        </zhimo-tab>
      </zhimo-tabs>

      <zhimo-modal ref="confirmModal" title="删除原理图">
        <p>确定删除「{{ detail.name }}」吗？此操作不可恢复。</p>
        <div slot="footer" style="display: flex; gap: 0.6rem; justify-content: flex-end">
          <zhimo-button variant="ghost" @click="confirmModal?.close()">取消</zhimo-button>
          <zhimo-button variant="danger" @click="remove">删除</zhimo-button>
        </div>
      </zhimo-modal>
    </template>
  </div>
</template>
