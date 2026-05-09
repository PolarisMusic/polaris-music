import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
        rollupOptions: {
            // Multi-page build. Without this, only index.html ships in
            // production and visualization.html is dev-only — its inline
            // <script type="module"> would never get extracted into a
            // CSP-compatible external chunk.
            input: {
                main:          resolve(__dirname, 'index.html'),
                visualization: resolve(__dirname, 'visualization.html'),
            },
        },
    },
});
