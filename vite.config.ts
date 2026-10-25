import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'plugins/latex-report-workbench/src/ui',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '^/api/': { target: 'http://127.0.0.1:4317', changeOrigin: true } } },
  build: { outDir: '../../dist/ui', emptyOutDir: true, cssCodeSplit: false, rolldownOptions: { output: { codeSplitting: false } } },
});
