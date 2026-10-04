import 'zhimo-ui'
// zhimo-ui injects tokens.css via new URL(), which Vite's dep optimizer
// cannot serve in dev (404); import the exported stylesheet directly so
// design tokens exist in both dev and build.
import 'zhimo-ui/tokens.css'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './style.css'

createApp(App).use(router).mount('#app')
