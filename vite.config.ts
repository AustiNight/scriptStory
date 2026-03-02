import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const apiPort = Number.parseInt(env.API_PORT || '4010', 10);
    const apiHost = env.API_HOST || '127.0.0.1';
    return {
      server: {
        port: 3000,
        host: '127.0.0.1',
        proxy: {
          '/api': {
            target: `http://${apiHost}:${apiPort}`,
            changeOrigin: false,
          }
        }
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
