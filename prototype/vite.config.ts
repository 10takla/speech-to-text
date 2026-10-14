import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

function reloadAppAfterSourceChange(): Plugin {
  const sourceDirectory = `${resolve(import.meta.dirname, 'src').replace(/\\/g, '/')}/`;
  return {
    name: 'reload-app-after-source-change',
    enforce: 'post',
    handleHotUpdate({ file, server }) {
      const normalizedFile = file.replace(/\\/g, '/');
      if (!normalizedFile.startsWith(sourceDirectory)) return;
      // Let Vite's CSS pipeline apply stylesheet changes through native HMR.
      if (/\.(?:css|scss|sass|less|styl)$/i.test(normalizedFile)) return;
      server.ws.send({ type: 'full-reload' });
      server.config.logger.info(`page reload src/${normalizedFile.slice(sourceDirectory.length)}`, { timestamp: true });
      return [];
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Tauri's Android page uses a proxy origin; the WebSocket must reach Vite via ADB reverse.
    ...(process.env.TAURI_ANDROID_PROJECT_PATH ? { hmr: { host: '127.0.0.1', clientPort: 5174 } } : {}),
    watch: { ignored: ['**/src-tauri/gen/**', '**/src-tauri/target/**', '**/.gradle/**', '**/dist/**'] },
  },
  plugins: [react(), reloadAppAfterSourceChange()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        overlay: resolve(import.meta.dirname, 'overlay.html'),
        bubble: resolve(import.meta.dirname, 'bubble.html'),
      },
    },
  },
});
