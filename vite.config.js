import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const buildCode = `BUILD-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

// https://vitejs.dev/config/
export default defineConfig({
  // Relative base so the build works when served from a sub-path
  // (e.g. GitHub Pages at https://<user>.github.io/<repo>/).
  base: './',
  define: {
    __BUILD_CODE__: JSON.stringify(buildCode)
  },
  plugins: [
    vue(),
    viteSingleFile()
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000, // 100MB to ensure all WASM reference resources are bundled
    chunkSizeWarningLimit: 100000
  }
});
