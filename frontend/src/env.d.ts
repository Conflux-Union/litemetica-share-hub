/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

declare module 'zhimo-ui' {
  export interface ToastOptions {
    type?: 'info' | 'success' | 'error' | 'warning'
    duration?: number
  }
  export function toast(message: string, options?: ToastOptions): void
}
