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

const HAS_DIST = existsSync(resolve(DIST_DIR, 'index.html'));

// Use describe.skip with a loud message when dist is missing so CI
// failure is informative rather than silent.
const describeOrSkip = HAS_DIST ? describe : describe.skip;

if (!HAS_DIST) {
    // eslint-disable-next-line no-console
    console.warn(
        '[dist-csp.test.js] SKIPPING: frontend/dist/index.html not found. ' +
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
    // Isolate the tag first, then read its content attribute.
    //
    // A single pattern with `content=["']([^"']+)["']` looks right and is not:
    // the value legitimately contains single quotes (`'self'`), so the negated
    // class stops at the first one and yields "default-src ". Every
    // `expect(...).not.toContain("'unsafe-eval'")` below then passed against an
    // empty array — the CSP gate was green without ever reading a CSP.
    const tag = (html.match(/<meta\b[^>]*>/gi) || []).find(
        t => /http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(t)
    );
    if (!tag) return null;

    const match = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)
        || tag.match(/\bcontent\s*=\s*'([^']*)'/i);
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

describeOrSkip('dist/index.html · CSP shape', () => {
    test('CSP meta tag exists', () => {
        const csp = extractCsp(readHtml('index.html'));
        expect(csp).not.toBeNull();
    });

    test('script-src does NOT contain unsafe-eval', () => {
        const csp = extractCsp(readHtml('index.html'));
        const directives = parseDirectives(csp);
        expect(directives['script-src'] || []).not.toContain("'unsafe-eval'");
    });

    test('script-src does NOT contain unsafe-inline', () => {
        const csp = extractCsp(readHtml('index.html'));
        const directives = parseDirectives(csp);
        // Note: style-src 'unsafe-inline' is intentionally allowed (inline
        // styles in template strings); only script-src is locked down.
        expect(directives['script-src'] || []).not.toContain("'unsafe-inline'");
    });

    test('script-src does NOT widen to *', () => {
        const csp = extractCsp(readHtml('index.html'));
        const directives = parseDirectives(csp);
        expect(directives['script-src'] || []).not.toContain('*');
    });

    test('default-src is set (defense in depth — fallback for unset directives)', () => {
        const csp = extractCsp(readHtml('index.html'));
        const directives = parseDirectives(csp);
        expect(directives['default-src']).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Inline-script regression net (the actual Stage E bug surface)
// ---------------------------------------------------------------------------

describeOrSkip('dist/index.html · no inline scripts', () => {
    test('every <script> tag has a src= attribute (no inline bodies)', () => {
        const tags = findScriptTags(readHtml('index.html'));
        const inline = tags.filter(t => !t.src && t.body.trim().length > 0);
        if (inline.length > 0) {
            // Make the failure self-explanatory.
            const excerpt = inline[0].body.trim().slice(0, 120) + '…';
            throw new Error(
                `Found ${inline.length} inline <script> block(s) in dist/index.html. ` +
                `Strict CSP (script-src 'self', no nonce/hash) blocks these. ` +
                `Source HTML must reference an external module file, OR vite.config.js ` +
                `must extract the inline block into the build. First inline body: ${excerpt}`
            );
        }
    });

    test('no <script> body uses eval() / new Function() (defense beyond CSP)', () => {
        const tags = findScriptTags(readHtml('index.html'));
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

describeOrSkip('dist/index.html · all script sources are same-origin', () => {
    test('no script src points at an http(s):// origin', () => {
        const tags = findScriptTags(readHtml('index.html'));
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
        const tags = findScriptTags(readHtml('index.html'));
        const bad = tags
            .map(t => t.src)
            .filter(src => src && /^(data|blob|javascript):/i.test(src));
        expect(bad).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// submit.html — the release form served at /submit.
//
// This page connects a wallet, signs, and posts to the API, so it needs the
// policy at least as much as the read-only visualizer. It nevertheless shipped
// with no CSP at all: the only assertion covering it was "the file exists".
// These mirror the index.html checks above.
// ---------------------------------------------------------------------------

describeOrSkip('dist/submit.html · CSP shape', () => {
    test('CSP meta tag exists', () => {
        const csp = extractCsp(readHtml('submit.html'));
        expect(csp).not.toBeNull();
    });

    test('script-src does NOT contain unsafe-eval', () => {
        const directives = parseDirectives(extractCsp(readHtml('submit.html')));
        expect(directives['script-src'] || []).not.toContain("'unsafe-eval'");
    });

    test('script-src does NOT contain unsafe-inline', () => {
        const directives = parseDirectives(extractCsp(readHtml('submit.html')));
        expect(directives['script-src'] || []).not.toContain("'unsafe-inline'");
    });

    test('script-src does NOT widen to *', () => {
        const directives = parseDirectives(extractCsp(readHtml('submit.html')));
        expect(directives['script-src'] || []).not.toContain('*');
    });

    test('default-src is set (fallback for unset directives)', () => {
        const directives = parseDirectives(extractCsp(readHtml('submit.html')));
        expect(directives['default-src']).toBeDefined();
    });

    // Signing depends on these. A policy that omits them looks tighter and
    // silently breaks wallet connection, which is worse than having none.
    test('connect-src still permits the wallet and the API', () => {
        const sources = parseDirectives(extractCsp(readHtml('submit.html')))['connect-src'] || [];
        expect(sources).toContain('https://*.anchor.link');
        expect(sources).toContain('wss://*.anchor.link');
        expect(sources).toContain('https://api.polaris.mu');
    });

    test('frame-src still permits the wallet popup', () => {
        const sources = parseDirectives(extractCsp(readHtml('submit.html')))['frame-src'] || [];
        expect(sources).toContain('https://*.anchor.link');
    });
});

describeOrSkip('dist/submit.html · no inline scripts', () => {
    test('every <script> tag has a src= attribute', () => {
        const inline = findScriptTags(readHtml('submit.html')).filter(t => !t.src && t.body.trim());
        expect(inline).toHaveLength(0);
    });

    test('no script src points at an http(s):// origin', () => {
        const external = findScriptTags(readHtml('submit.html'))
            .map(t => t.src)
            .filter(src => src && /^https?:\/\//i.test(src));
        expect(external).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Cross-page drift.
//
// The two policies are maintained by hand in two files. Nothing stops them
// diverging, and divergence is exactly how /submit ended up unprotected. Pin
// the differences that are intentional so any other difference fails here.
// ---------------------------------------------------------------------------

describeOrSkip('CSP parity between index.html and submit.html', () => {
    // submit.html has no MiniPlayer, so no Spotify embed and no audio element.
    const INTENTIONAL_DIFFERENCES = {
        'media-src': 'index only — the MiniPlayer plays audio; the form does not',
        'spotify': 'index only — the MiniPlayer embeds Spotify; the form does not',
    };

    const indexDirectives = () => parseDirectives(extractCsp(readHtml('index.html')));
    const submitDirectives = () => parseDirectives(extractCsp(readHtml('submit.html')));

    test('both pages declare the same directive names, except media-src', () => {
        const inIndex = Object.keys(indexDirectives()).sort();
        const inSubmit = Object.keys(submitDirectives()).sort();
        const onlyInIndex = inIndex.filter(d => !inSubmit.includes(d));
        const onlyInSubmit = inSubmit.filter(d => !inIndex.includes(d));

        expect(onlyInIndex).toEqual(['media-src']);   // INTENTIONAL_DIFFERENCES
        expect(onlyInSubmit).toEqual([]);
    });

    test('shared directives are identical once Spotify is set aside', () => {
        const index = indexDirectives();
        const submit = submitDirectives();

        for (const name of Object.keys(submit)) {
            const indexSources = (index[name] || []).filter(s => !s.includes('open.spotify.com'));
            expect({ [name]: submit[name] }).toEqual({ [name]: indexSources });
        }
    });

    test('the intentional differences are documented, not accidental', () => {
        // Guards against someone widening the exemption list to silence a
        // genuine divergence.
        expect(Object.keys(INTENTIONAL_DIFFERENCES).sort()).toEqual(['media-src', 'spotify']);
    });
});

// ---------------------------------------------------------------------------
// Multi-page build sanity: BOTH entry points must reach the production
// bundle, not just be served in dev mode. index.html is the graph (home);
// submit.html is the release form served at /submit.
// ---------------------------------------------------------------------------

describeOrSkip('dist/ multi-page build', () => {
    test('dist/index.html is present', () => {
        expect(existsSync(resolve(DIST_DIR, 'index.html'))).toBe(true);
    });

    // The one that actually proves the multi-page config works — a broken
    // rollupOptions.input drops this while still emitting index.html.
    test('dist/submit.html is present', () => {
        expect(existsSync(resolve(DIST_DIR, 'submit.html'))).toBe(true);
    });

    test('index.html references at least one extracted-module chunk under /assets', () => {
        const tags = findScriptTags(readHtml('index.html'));
        const moduleChunks = tags
            .map(t => t.src)
            .filter(src => src && /^\/?assets\/.+\.js$/.test(src));
        // Confirms the inline `<script type="module">` block was actually
        // hoisted by vite-build (the whole point of the fix).
        expect(moduleChunks.length).toBeGreaterThan(0);
    });
});
