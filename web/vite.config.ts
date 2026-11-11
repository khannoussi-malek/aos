import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev the API is on :8001 (docker compose api); in Docker nginx proxies /api instead.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8001' } },
})
