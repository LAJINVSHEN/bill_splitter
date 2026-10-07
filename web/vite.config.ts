import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const API_TARGET = process.env.VITE_DEV_API_TARGET ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  // VITE_* come from the repo-root .env (only VITE_-prefixed keys reach the bundle).
  envDir: '..',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
    fs: { allow: ['..'] },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
})
