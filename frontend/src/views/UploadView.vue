<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from 'zhimo-ui'
import { api, ApiError } from '../api'
import { boolAttr } from '../compat'
import { useAuth } from '../auth'
import FileDrop from '../components/FileDrop.vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const { state, load } = useAuth()
const file = ref<File | null>(null)
const description = ref('')
const uploading = ref(false)

onMounted(load)

function goLogin() {
  window.location.href = '/api/auth/login'
}

async function submit() {
  if (!file.value || uploading.value) return
  uploading.value = true
  try {
    const { id } = await api.upload(file.value, description.value)
    toast('上传成功', { type: 'success' })
    router.push(`/schematics/${id}`)
  } catch (e) {
    toast(e instanceof ApiError ? e.message : '上传失败', { type: 'error' })
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="page" style="max-width: 640px">
    <div v-if="!state.loaded" style="text-align: center; padding: 4rem">
      <zhimo-spinner></zhimo-spinner>
    </div>

    <div v-else-if="!state.user" class="auth-panel">
      <p style="font-size: 1.1rem">上传需要先登录</p>
      <p class="muted">登录通过 RMSSSO 统一认证完成。</p>
      <zhimo-button @click="goLogin">前往登录</zhimo-button>
    </div>

    <template v-else>
      <h2 style="margin-top: 0">上传原理图</h2>
      <div style="display: flex; flex-direction: column; gap: 1rem">
        <FileDrop @select="(f) => (file = f)" />
        <zhimo-input
          label="描述（可选，留空使用原理图自带描述）"
          textarea
          :rows="3"
          :value="description"
          maxlength="500"
          @input="description = $event.target.value"
        ></zhimo-input>
        <div>
          <zhimo-button
            :loading="boolAttr(uploading)"
            :disabled="boolAttr(!file)"
            @click="submit"
          >
            {{ uploading ? '上传中…' : '上传' }}
          </zhimo-button>
        </div>
      </div>
    </template>
  </div>
</template>
