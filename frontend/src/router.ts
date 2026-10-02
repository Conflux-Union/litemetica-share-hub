import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'list', component: () => import('./views/ListView.vue') },
    {
      path: '/schematics/:id',
      name: 'detail',
      component: () => import('./views/DetailView.vue'),
      props: true,
    },
    { path: '/upload', name: 'upload', component: () => import('./views/UploadView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
