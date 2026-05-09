/**
 * Static CSP regression test for the production frontend build.
 *
 * The visualization page ships a strict CSP (`script-src 'self'`, no
 * 'unsafe-eval', no 'unsafe-inline', no nonce, no hash). For that to
 * actually work, three structural conditions must hold in the BUILT
 * HTML at `frontend/dist/`:
 *
 *   1. Every <script> tag carries a `src=` attribute (no inline bodies).
 *      Inline `<script type="module">` blocks would be blocked by the
 *      strict policy in any browser that enforces CSP.
 *   2. Script sources must be same-origin (start with `/`, `./`, or
 *      ``${ORIGIN}/``) — anything else would need to be allow-listed
 *      in `script-src`.
 *   3. The CSP itself must NOT regain `'unsafe-eval'` or `'unsafe-inline'`
 *      under `script-src`, and must NOT widen to `*`.
 *
 * Stage E ("remove unsafe-eval from CSP") claimed Playwright/Chromium
 * verification but no Playwright tests existed. This static check is
 * the loud, fast, browser-free version. The companion Playwright spec
 * at `frontend/test/e2e/csp.spec.js` adds runtime CSP-violation
 * monitoring; it's gated behind FRONTEND_E2E because not all CI
 * environments can fetch the headless browser binaries.
 *
 * Prerequisite: `cd frontend && npm install && npm run build` must have
 * already produced `frontend/dist/`. The test SKIPS (with a clear
 * message) when dist/ is missing rather than spawning an in-test build,
 * because vite-build is slow (~5s) and pulls a large dependency
 * footprint that is better owned by a dedicated CI step.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_DIR = resolve(__dirname, '../../../frontend/dist');

const HAS_DIST = existsSync(resolve(DIST_DIR, 'visualization.html'));

// Use describe.skip with a loud message when dist is missing so CI
// failure is informative rather than silent.
const describeOrSkip = HAS_DIST ? describe : describe.skip;

if (!HAS_DIST) {
    // eslint-disable-next-line no-console
    console.warn(
        '[dist-csp.test.js] SKIPPING: frontend/dist/visualization.html not found. ' +
        'Run `cd frontend && npm install && npm run build` before this test.'
    );
}

// ---------------------------------------------------------------------------
// HTML probe helpers (regex-based; avoids pulling in a parser dep). These are
// deliberately permissive about whitespace and attribute order.
// ---------------------------------------------------------------------------

function readHtml(name) {
    return readFileSync(resolve(DIST_DIR, name), 'utf8');
}

/**
 * Extract the CSP `<meta http-equiv="Content-Security-Policy" content="…">`
 * from the HTML. Returns null if no such tag exists.
 */
function extractCsp(html) {
    const match = html.match(
        /<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]+content\s*=\s*["']([^"']+)["']/i
    );
    return match ? match[1] : null;
}

function parseDirectives(csp) {
    const out = {};
    csp.split(';').forEach(part => {
        const trimmed = part.trim();
        if (!trimmed) return;
        const [name, ...sources] = trimmed.split(/\s+/);
        out[name.toLowerCase()] = sources;
    });
    return out;
}

/**
 * Find every `<script ...>` tag and report `src=` (or null for inline).
 * The body content is captured for inline scripts so failing tests can
 * show a useful excerpt.
 */
function findScriptTags(html) {
    const tags = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = m[1];
        const body = m[2];
        const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
        tags.push({ src: srcMatch ? srcMatch[1] : null, body });
    }
    return tags;
}

// ---------------------------------------------------------------------------
// CSP shape
// ---------------------------------------------------------------------------

describeOrSkip('dist/visualization.html · CSP shape', () => {
    test('CSP meta tag exists', () => {
        const csp = extractCsp(readHtml('visualization.html'));
        expect(csp).not.toBeNull();
    });

    test('script-src does NOT contain unsafe-eval', () => {
        const csp = extractCsp(readHtml('visualization.html'));
        const directives = parseDirectives(csp);
        expect(directives['script-src'] || []).not.toContain("'unsafe-eval'");
    });

    test('script-src does NOT contain unsafe-inline', () => {
        const csp = extractCsp(readHtml('visualization.html'));
        const directives = parseDirectives(csp);
        // Note: style-src 'unsafe-inline' is intentionally allowed (inline
        // styles in template strings); only script-src is locked down.
        expect(directives['script-src'] || []).not.toContain("'unsafe-inline'");
    });

    test('script-src does NOT widen to *', () => {
        const csp = extractCsp(readHtml('visualization.html'));
        const directives = parseDirectives(csp);
        expect(directives['script-src'] || []).not.toContain('*');
    });

    test('default-src is set (defense in depth — fallback for unset directives)', () => {
        const csp = extractCsp(readHtml('visualization.html'));
        const directives = parseDirectives(csp);
        expect(directives['default-src']).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Inline-script regression net (the actual Stage E bug surface)
// ---------------------------------------------------------------------------

describeOrSkip('dist/visualization.html · no inline scripts', () => {
    test('every <script> tag has a src= attribute (no inline bodies)', () => {
        const tags = findScriptTags(readHtml('visualization.html'));
        const inline = tags.filter(t => !t.src && t.body.trim().length > 0);
        if (inline.length > 0) {
            // Make the failure self-explanatory.
            const excerpt = inline[0].body.trim().slice(0, 120) + '…';
            throw new Error(
                `Found ${inline.length} inline <script> block(s) in dist/visualization.html. ` +
                `Strict CSP (script-src 'self', no nonce/hash) blocks these. ` +
                `Source HTML must reference an external module file, OR vite.config.js ` +
                `must extract the inline block into the build. First inline body: ${excerpt}`
            );
        }
    });

    test('no <script> body uses eval() / new Function() (defense beyond CSP)', () => {
        const tags = findScriptTags(readHtml('visualization.html'));
        for (const tag of tags) {
            if (!tag.body) continue;
            // Strip comments before grepping so legit comments don't trip us.
            const stripped = tag.body
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).not.toMatch(/\beval\s*\(/);
            expect(stripped).not.toMatch(/\bnew\s+Function\s*\(/);
        }
    });
});

// ---------------------------------------------------------------------------
// Same-origin script sources
// ---------------------------------------------------------------------------

describeOrSkip('dist/visualization.html · all script sources are same-origin', () => {
    test('no script src points at an http(s):// origin', () => {
        const tags = findScriptTags(readHtml('visualization.html'));
        const externalSchemes = tags
            .map(t => t.src)
            .filter(src => src && /^https?:\/\//i.test(src));
        if (externalSchemes.length > 0) {
            throw new Error(
                `External-origin <script src> values would need a CSP allowlist: ` +
                externalSchemes.join(', ')
            );
        }
    });

    test('no script src uses data: / blob: / javascript: schemes', () => {
        const tags = findScriptTags(readHtml('visualization.html'));
        const bad = tags
            .map(t => t.src)
            .filter(src => src && /^(data|blob|javascript):/i.test(src));
        expect(bad).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Multi-page build sanity (added in Step 3 — `visualization.html` must
// actually be in the production bundle, not just dev-mode-served).
// ---------------------------------------------------------------------------

describeOrSkip('dist/ multi-page build', () => {
    test('dist/visualization.html is present', () => {
        expect(existsSync(resolve(DIST_DIR, 'visualization.html'))).toBe(true);
    });

    test('dist/index.html is present', () => {
        expect(existsSync(resolve(DIST_DIR, 'index.html'))).toBe(true);
    });

    test('visualization.html references at least one extracted-module chunk under /assets', () => {
        const tags = findScriptTags(readHtml('visualization.html'));
        const moduleChunks = tags
            .map(t => t.src)
            .filter(src => src && /^\/?assets\/.+\.js$/.test(src));
        // Confirms the inline `<script type="module">` block was actually
        // hoisted by vite-build (the whole point of the fix).
        expect(moduleChunks.length).toBeGreaterThan(0);
    });
});
