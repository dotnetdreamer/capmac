import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The renderer: React + TypeScript, served from app://capmac/ when packaged.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1' },
  worker: { format: 'es' },
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
    target: 'chrome150',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
  },
});
