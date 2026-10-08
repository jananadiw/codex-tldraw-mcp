import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  root: 'app',
  plugins: [react(), viteSingleFile()],
  build: {
    target: 'es2022',
    outDir: '../dist',
    emptyOutDir: false,
    rollupOptions: {
      input: 'app/app.html',
    },
  },
})
