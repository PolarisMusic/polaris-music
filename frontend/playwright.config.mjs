/**
 * Playwright configuration for the Polaris frontend end-to-end suite.
 *
 * Currently scoped to a single concern: verify that `dist/visualization.html`
 * loads under its strict CSP without firing a `securitypolicyviolation`
 * event. The Stage E refactor removed `'unsafe-eval'` and the multi-page
 * Vite build extracts the previously-inline `<script type="module">` block
 * — these tests are the runtime regression net for both.
 *
 * Run locally:
 *   cd frontend
 *   npm install
 *   npm run build
 *   npx playwright install chromium    # ~150MB browser download
 *   npx playwright test
 *
 * In CI: the e2e job is gated behind FRONTEND_E2E=true so environments
 * without browser-binary network access don't fail. The lightweight static
 * counterpart in `backend/test/frontend/dist-csp.test.js` always runs and
 * catches the same inline-script and CSP-shape regressions; Playwright
 * adds the runtime layer (was the page actually CSP-clean when loaded?).
 */

import { defineConfig } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    testDir: './test/e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? 'github' : 'list',

    use: {
        // Serve the built dist/ over a static HTTP server so the page loads
        // under a real http://localhost origin (file:// has different CSP
        // behavior and would mask bugs).
        baseURL: 'http://127.0.0.1:4173',
        trace: 'on-first-retry',
    },

    // Boot vite preview against the production build before tests run.
    // (vite preview serves dist/ and respects the multi-page output.)
    webServer: {
        command: 'npx vite preview --host 127.0.0.1 --port 4173',
        url: 'http://127.0.0.1:4173/visualization.html',
        timeout: 30_000,
        reuseExistingServer: !process.env.CI,
        cwd: resolve(__dirname),
    },

    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' },
        },
    ],
});
