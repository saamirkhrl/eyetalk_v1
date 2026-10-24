import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  // transformers.js / onnxruntime-web ship esm + wasm that vite's dep pre-bundler
  // mangles. excluding them keeps the dynamic wasm/webgpu loaders intact.
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
  build: {
    // onnxruntime-web needs top-level await + bigint.
    target: 'esnext',
    chunkSizeWarningLimit: 4096,
  },
  server: {
    // getusermedia requires a secure context: localhost counts, so plain http is fine
    // for local dev. for lan testing use `npm run dev -- --host` over a tunnel.
    port: 5173,
  },
});
