import { defineConfig } from 'vite'

export default defineConfig({
  // The protocol creates its worker with `new Worker(new URL(..., import.meta.url))`,
  // which pre-bundling would break.
  optimizeDeps: { exclude: ['@yutannihilation/tilewarp'] },
})
