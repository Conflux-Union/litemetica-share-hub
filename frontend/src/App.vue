<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuth } from './auth'

const { state, load, logout } = useAuth()

onMounted(load)

function toggleTheme() {
  const html = document.documentElement
  const dark = html.getAttribute('data-theme') === 'dark'
  if (dark) html.removeAttribute('data-theme')
  else html.setAttribute('data-theme', 'dark')
  localStorage.setItem('lsh-theme', dark ? 'light' : 'dark')
}

function goLogin() {
  window.location.href = '/api/auth/login'
}
</script>

<template>
  <zhimo-navbar>
    <span slot="brand" style="font-weight: 700; cursor: pointer" @click="$router.push('/')">
      {{ state.config?.site_name ?? 'Litemetica Share Hub' }}
    </span>
    <div slot="actions" class="user-chip">
      <zhimo-button variant="ghost" @click="$router.push('/upload')" v-if="state.user">
        上传
      </zhimo-button>
      <zhimo-button variant="ghost" @click="toggleTheme">日夜</zhimo-button>
      <template v-if="state.user">
        <span class="user-chip">
          <img v-if="state.user.avatar_url" :src="state.user.avatar_url" alt="avatar" />
          <span>{{ state.user.nickname || state.user.username }}</span>
        </span>
        <zhimo-button variant="ghost" @click="logout().then(() => $router.push('/'))">
          登出
        </zhimo-button>
      </template>
      <zhimo-button v-else @click="goLogin">登录</zhimo-button>
    </div>
  </zhimo-navbar>

  <router-view />
</template>
