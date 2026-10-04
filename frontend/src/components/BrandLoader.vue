<script setup lang="ts">
withDefaults(defineProps<{ text?: string }>(), { text: '加载中…' })
</script>

<template>
  <div class="brand-loader" role="status" :aria-label="text">
    <div class="brand-loader-mark" aria-hidden="true"></div>
    <div v-if="text" class="brand-loader-text">{{ text }}</div>
  </div>
</template>

<style scoped>
/* CONFLUX UNION wordmark rendered as a CSS mask, so only the glyph
   strokes are painted and the sweep below stays inside the ink. */
.brand-loader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.9rem;
}

.brand-loader-mark {
  position: relative;
  width: min(320px, 64vw);
  aspect-ratio: 1920 / 1080;
  /* Ghost/skeleton material: translucent gray ink, not solid black. */
  background: color-mix(in srgb, var(--zhimo-fg, #1a1714) 22%, transparent);
  overflow: hidden;
  -webkit-mask: url('../assets/logo.svg') center / contain no-repeat;
  mask: url('../assets/logo.svg') center / contain no-repeat;
}

/* A1 sweep: one light band travels through the strokes for ~1.9s,
   then rests ~1.8s before the next pass (3.7s cycle). */
.brand-loader-mark::after {
  content: '';
  position: absolute;
  top: -25%;
  bottom: -25%;
  left: 0;
  width: 28%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 250, 238, 0.5) 32%,
    rgba(255, 255, 255, 0.92) 50%,
    rgba(255, 250, 238, 0.5) 68%,
    transparent
  );
  transform: translateX(-140%) skewX(-16deg);
  animation: brand-loader-sweep 3.7s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

/* Dark strokes are light, so a plain white core would vanish; edge the
   band with terracotta to keep the glint visible on light ink. */
[data-theme='dark'] .brand-loader-mark::after {
  background: linear-gradient(
    90deg,
    transparent,
    rgba(233, 147, 116, 0.65) 28%,
    rgba(255, 252, 244, 0.95) 50%,
    rgba(233, 147, 116, 0.65) 72%,
    transparent
  );
}

.brand-loader-text {
  font-size: 0.85rem;
  letter-spacing: 0.35em;
  padding-left: 0.35em; /* optically re-center letter-spaced text */
  color: var(--zhimo-fg-muted, #7a7265);
}

@keyframes brand-loader-sweep {
  0% {
    transform: translateX(-140%) skewX(-16deg);
  }
  51.35%,
  100% {
    transform: translateX(320%) skewX(-16deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .brand-loader-mark::after {
    animation: none;
    opacity: 0;
  }
}
</style>
