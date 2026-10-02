import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // zhimo-ui ships framework-agnostic web components.
          isCustomElement: (tag) => tag.startsWith('zhimo-'),
        },
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/oauth': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    // three.js is big; hint chunking for the viewer path.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
})
