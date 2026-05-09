/**
 * Playwright e2e — runtime CSP regression for visualization.html
 *
 * Loads the production-built page under a real Chromium instance and:
 *   1. Asserts no `securitypolicyviolation` events fire during load and
 *      first-paint settling (would prove the inline-script extraction
 *      and unsafe-eval removal are real, not just structural).
 *   2. Asserts the JIT graph container is present in the DOM (cheap
 *      smoke test — if the page silently failed to boot, this catches it).
 *
 * The static counterpart in `backend/test/frontend/dist-csp.test.js`
 * runs in regular CI and is the primary gate; this spec adds the runtime
 * layer for environments that can host a headless browser. See
 * `frontend/playwright.config.js` for invocation.
 */

import { test, expect } from '@playwright/test';

test('visualization.html loads with zero CSP violations', async ({ page }) => {
    const violations = [];
    const requestFailures = [];

    // CSP violations bubble up as a securitypolicyviolation event on the
    // document. We translate them to console errors via an init script,
    // then catch them in the test runner.
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            // Stringify the bits we care about — the event itself is not
            // structured-cloneable in some Playwright versions.
            const detail = {
                violatedDirective: e.violatedDirective,
                blockedURI: e.blockedURI,
                effectiveDirective: e.effectiveDirective,
                sourceFile: e.sourceFile,
                lineNumber: e.lineNumber,
            };
            // eslint-disable-next-line no-console
            console.error('CSP_VIOLATION ' + JSON.stringify(detail));
        });
    });

    page.on('console', (msg) => {
        const text = msg.text();
        if (msg.type() === 'error' && text.startsWith('CSP_VIOLATION ')) {
            try {
                violations.push(JSON.parse(text.slice('CSP_VIOLATION '.length)));
            } catch {
                violations.push({ raw: text });
            }
        }
    });

    page.on('requestfailed', (req) => {
        requestFailures.push({ url: req.url(), failure: req.failure()?.errorText });
    });

    await page.goto('/visualization.html', { waitUntil: 'load' });

    // Give the inline-extracted module a tick to evaluate.
    await page.waitForTimeout(500);

    if (violations.length > 0) {
        throw new Error(
            `Found ${violations.length} CSP violation(s):\n` +
            violations.map(v => '  ' + JSON.stringify(v)).join('\n')
        );
    }

    // Smoke check: the visualization wires its hypertree into #viz-container.
    // Even without graph data loaded (no backend), the element should exist.
    await expect(page.locator('#viz-container')).toBeAttached();

    // Surface unrelated request failures (e.g. CDN scripts blocked) for
    // diagnostic value — they don't fail the test by themselves.
    if (requestFailures.length > 0) {
        // eslint-disable-next-line no-console
        console.warn('Non-CSP request failures (informational):',
            requestFailures.map(f => `${f.url} (${f.failure})`).join(', '));
    }
});

test('CSP meta tag matches build expectations', async ({ page }) => {
    await page.goto('/visualization.html', { waitUntil: 'domcontentloaded' });
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');
    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/'unsafe-eval'/);
    // script-src must explicitly NOT have unsafe-inline (style-src may).
    const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    expect(scriptSrcMatch[1]).not.toContain("'unsafe-inline'");
});
