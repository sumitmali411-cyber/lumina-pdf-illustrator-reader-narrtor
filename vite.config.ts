import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const apiPort = env.PORT || '8080';

  return {
    plugins: [react(), tailwindcss()],
    // NOTE: never `define` GEMINI_API_KEY here. Anything defined at build time
    // is inlined into the client bundle and readable by every visitor. The key
    // is used only by the Express server in server/index.ts.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: false,
        },
      },
    },
  };
});
