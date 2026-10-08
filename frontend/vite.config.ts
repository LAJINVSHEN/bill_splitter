import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'ethyl-intersystem-immoderately.ngrok-free.dev',
    ],
    port: 5173,
    proxy: {
      '/api': {
        // Forward API calls to the FastAPI backend (running on port 8000)
        target: 'http://localhost:8000',
        changeOrigin: true      
      }
    }
  }
})
