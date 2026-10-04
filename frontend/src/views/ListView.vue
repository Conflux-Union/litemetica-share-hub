<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from 'zhimo-ui'
import { api, ApiError } from '../api'
import { boolAttr } from '../compat'
import { useAuth } from '../auth'
import type { ListResponse } from '../types'
import SchematicCard from '../components/SchematicCard.vue'
import BrandLoader from '../components/BrandLoader.vue'

const { state, load } = useAuth()
const result = ref<ListResponse | null>(null)
const error = ref('')
const loading = ref(false)
const q = ref('')
const page = ref(1)
const size = 24

async function fetchList() {
  loading.value = true
  error.value = ''
  try {
    result.value = await api.list(page.value, size, q.value)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  const loginError = new URLSearchParams(location.search).get('login_error')
  if (loginError) {
    toast(decodeURIComponent(loginError), { type: 'error' })
    history.replaceState(null, '', '/')
  }
  fetchList()
})

function search() {
  page.value = 1
  fetchList()
}

function prev() {
  if (page.value > 1) {
    page.value--
    fetchList()
  }
}

function next() {
  if (result.value && page.value * size < result.value.total) {
    page.value++
    fetchList()
  }
}
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <zhimo-input
        placeholder="搜索名称 / 作者 / 描述…"
        :value="q"
        style="max-width: 320px"
        @input="q = $event.target.value"
        @keydown.enter="search"
      ></zhimo-input>
      <zhimo-button variant="secondary" @click="search">搜索</zhimo-button>
      <span class="spacer"></span>
      <zhimo-button v-if="state.user" @click="$router.push('/upload')">上传原理图</zhimo-button>
    </div>

    <div v-if="error" class="auth-panel">
      <p>{{ error }}</p>
      <zhimo-button variant="secondary" @click="fetchList">重试</zhimo-button>
    </div>

    <div v-else-if="loading && !result" class="page-loader">
      <BrandLoader />
    </div>

    <div v-else-if="result && result.items.length === 0" class="auth-panel">
      <p>还没有原理图。</p>
      <p v-if="!state.user" class="muted">登录后即可上传第一个 .litematic 文件。</p>
      <zhimo-button v-if="state.user" @click="$router.push('/upload')">上传原理图</zhimo-button>
    </div>

    <template v-else-if="result">
      <div class="card-grid">
        <SchematicCard
          v-for="s in result.items"
          :key="s.id"
          :schematic="s"
        />
      </div>
      <div class="toolbar" style="justify-content: center; margin-top: 1.5rem">
        <zhimo-button variant="ghost" :disabled="boolAttr(page <= 1)" @click="prev">上一页</zhimo-button>
        <span class="muted">第 {{ page }} 页 / 共 {{ Math.max(1, Math.ceil(result.total / size)) }} 页</span>
        <zhimo-button variant="ghost" :disabled="boolAttr(page * size >= result.total)" @click="next">
          下一页
        </zhimo-button>
      </div>
    </template>
  </div>
</template>
