/**
 * Installing this package must not download a browser.
 *
 * Nothing under backend/ drives one. The Playwright suites live in frontend/
 * and bring their own; this directory gets `@playwright/browser-chromium`
 * transitively, from artillery -> artillery-engine-playwright, and that
 * package exists to run a postinstall that fetches ~150MB of Chromium.
 *
 * Which makes every `npm ci` here a build-time dependency on Microsoft's CDN
 * publishing a build for whatever host is installing. On 2026-10-19 that
 * stopped being true: GitHub's `ubuntu-latest` moved to Ubuntu 26.04,
 * playwright-core resolves that host to `ubuntu26.04-x64`, no such download
 * exists, the postinstall threw, and `npm ci` exited 1 — taking the lint,
 * backend-test and frontend-CSP jobs down with it, on a commit that had
 * touched none of them. Upgrading does not fix it; 1.59.1 maps 26.04 the same
 * way.
 *
 * `.npmrc` is the fix, and CI exercises it on every run. What CI cannot catch
 * is the Dockerfile half: leave `.npmrc` out of the build context and the
 * image still builds, just carrying a glibc browser build that cannot run on
 * musl. Hence this test.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('npm install in backend/', () => {
    test('.npmrc switches the browser download off', () => {
        const npmrc = readFileSync(join(BACKEND, '.npmrc'), 'utf8');

        // npm hands this to install scripts as
        // npm_config_playwright_skip_browser_download, which is the second
        // place playwright-core's getFromENV looks.
        const setting = npmrc.split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .find((line) => line.startsWith('playwright_skip_browser_download='));

        expect(setting).toBeDefined();
        expect(setting.split('=')[1].trim()).toBe('1');
    });

    test('the image build has .npmrc in place before it installs', () => {
        const dockerfile = readFileSync(join(BACKEND, 'Dockerfile'), 'utf8').split('\n');

        const copiesNpmrc = dockerfile.findIndex(
            (line) => /^COPY\b/.test(line.trim()) && line.includes('.npmrc'));
        const installs = dockerfile.findIndex(
            (line) => /^RUN\s+npm\s+ci\b/.test(line.trim()));

        expect(copiesNpmrc).toBeGreaterThanOrEqual(0);
        expect(installs).toBeGreaterThanOrEqual(0);
        // Order is the whole point: a COPY after the install is a file the
        // install never saw.
        expect(copiesNpmrc).toBeLessThan(installs);
    });
});
