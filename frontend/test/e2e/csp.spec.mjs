/**
 * Playwright e2e — runtime CSP regression for the visualizer entry page
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

test('index.html (visualizer) loads with zero CSP violations', async ({ page }) => {
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

    await page.goto('/', { waitUntil: 'load' });

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
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');
    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/'unsafe-eval'/);
    // script-src must explicitly NOT have unsafe-inline (style-src may).
    const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    expect(scriptSrcMatch[1]).not.toContain("'unsafe-inline'");
});

// ---------------------------------------------------------------------------
// /submit — the release form. It connects a wallet, signs, and posts to the
// API, and it shipped with no CSP at all while the read-only graph page was
// locked down. These are the runtime counterpart to the static checks in
// backend/test/frontend/dist-csp.test.js.
// ---------------------------------------------------------------------------

test('submit.html loads with zero CSP violations', async ({ page }) => {
    const violations = [];

    await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolations.push({
                directive: e.violatedDirective,
                blockedURI: e.blockedURI,
            });
        });
    });

    page.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) {
            violations.push({ source: 'console', text: msg.text() });
        }
    });

    await page.goto('/submit', { waitUntil: 'load' });
    await page.waitForTimeout(500);

    const pageViolations = await page.evaluate(() => window.__cspViolations || []);
    const all = [...violations, ...pageViolations];

    if (all.length > 0) {
        throw new Error(
            `Found ${all.length} CSP violation(s) on /submit:\n` +
            all.map(v => '  ' + JSON.stringify(v)).join('\n')
        );
    }

    // The form itself must have rendered — a policy that blocked the module
    // script would leave the shell without it.
    await expect(page.locator('#submit-tab')).toBeAttached();
});

test('submit.html keeps the origins wallet signing depends on', async ({ page }) => {
    await page.goto('/submit', { waitUntil: 'domcontentloaded' });
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');

    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/'unsafe-eval'/);

    // Tightening the policy past these breaks wallet connection, which is a
    // worse outcome than the missing policy this replaced.
    expect(csp).toContain('https://*.anchor.link');
    expect(csp).toContain('wss://*.anchor.link');
    expect(csp).toContain('https://api.polaris.mu');
});
