import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs so the build works under any path, e.g. /tilewarp/ on GitHub Pages.
  base: './',
  // The protocol creates its worker with `new Worker(new URL(..., import.meta.url))`,
  // which pre-bundling would break.
  optimizeDeps: { exclude: ['@yutannihilation/tilewarp'] },
})
