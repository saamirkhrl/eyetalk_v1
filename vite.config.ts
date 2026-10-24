import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  // transformers.js / onnxruntime-web ship ESM + WASM that Vite's dep pre-bundler
  // mangles. Excluding them keeps the dynamic wasm/webgpu loaders intact.
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
  build: {
    // onnxruntime-web needs top-level await + BigInt.
    target: 'esnext',
    chunkSizeWarningLimit: 4096,
  },
  server: {
    // getUserMedia requires a secure context: localhost counts, so plain http is fine
    // for local dev. For LAN testing use `npm run dev -- --host` over a tunnel.
    port: 5173,
  },
});
