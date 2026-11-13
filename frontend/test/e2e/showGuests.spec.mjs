/**
 * The credit toggles.
 *
 * `GUEST_ON` is a fallback bucket: everyone who is not a member of the
 * performing group lands in it, so a featured vocalist and the person who shot
 * the sleeve arrive over identical edges. Hiding the whole bucket by default
 * pushed a submitter with an interesting session player to show into filing
 * them as a *member* to make the connection visible — a display default
 * corrupting the data. So the bucket is asked for in halves, and the halves
 * get different defaults.
 *
 * Three things to hold onto. The first load has to actually ask for musical
 * guests, or the default is a lie. The technical half has to stay out until
 * asked for, or the toggle is decoration. And a guest edge must not be painted
 * as a membership: both run Person → Group, the styling rules key off the node
 * types at each end, and the member/guest distinction is the one this registry
 * exists to record.
 */

import { test, expect } from '@playwright/test';

const BAND = { id: 'grp:band', name: 'Test Band', type: 'group' };
const DRUMMER = { id: 'per:drums', name: 'A Drummer', type: 'person', color: '#aabbcc' };
const SAX = { id: 'per:sax', name: 'A Saxophonist', type: 'person', color: '#ff8800' };
const SLEEVE = { id: 'per:sleeve', name: 'A Designer', type: 'person', color: '#33cc99' };

const MEMBER_EDGE = {
    source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums',
};
const SAX_EDGE = {
    source: 'per:sax', target: 'grp:band', type: 'GUEST_ON',
    trackCount: 2, scope: 'track', role: 'saxophone', roles: ['saxophone'],
};
const SLEEVE_EDGE = {
    source: 'per:sleeve', target: 'grp:band', type: 'GUEST_ON',
    trackCount: 1, scope: 'release', role: 'artwork', roles: ['artwork'],
};

/**
 * The payload the real route would build for a given set of flags, so the
 * stub answers the URL the client actually sends rather than a fixed body.
 *
 * @param {URL} url
 */
function payloadFor(url) {
    const asked = (name) => url.searchParams.get(name) === 'true';
    const all = asked('guests');
    const musical = all || asked('musicalGuests');
    const technical = all || asked('technicians');

    const nodes = [BAND, DRUMMER];
    const edges = [MEMBER_EDGE];
    if (musical) { nodes.push(SAX); edges.push(SAX_EDGE); }
    if (technical) { nodes.push(SLEEVE); edges.push(SLEEVE_EDGE); }
    return { nodes, edges };
}

async function boot(page) {
    const requested = [];
    // Registered first on purpose: Playwright matches the most recently added
    // route, so the broad catch-all has to go down before the specific ones or
    // it answers /api/graph/initial with an empty object and the graph never
    // boots.
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) }));
    await page.route('**/graph/initial*', (route) => {
        const url = new URL(route.request().url());
        requested.push(url.search);
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(payloadFor(url)),
        });
    });
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
    return requested;
}

/** Every node id currently in the hypertree. */
const nodeIds = (page) => page.evaluate(() => {
    const ids = [];
    window.musicGraph.ht.graph.eachNode((n) => ids.push(n.id));
    return ids.sort();
});

const hasNode = (page, id) =>
    page.waitForFunction((nodeId) => !!window.musicGraph.ht.graph.getNode(nodeId), id,
        { timeout: 10_000 });
const lostNode = (page, id) =>
    page.waitForFunction((nodeId) => !window.musicGraph.ht.graph.getNode(nodeId), id,
        { timeout: 10_000 });

test.describe('musical guests', () => {
    test('are on from the first load, and the request says so', async ({ page }) => {
        // Not a server default — the server still answers a bare request with
        // members only. The client asks, so the box and the payload cannot
        // disagree about what is on screen.
        const requested = await boot(page);

        await expect(page.locator('#show-musical-guests')).toBeChecked();
        expect(requested[0]).toContain('musicalGuests=true');
        expect(await nodeIds(page)).toContain('per:sax');
    });

    test('and can be turned off, which takes the saxophonist away', async ({ page }) => {
        await boot(page);
        await page.locator('#show-musical-guests').uncheck();

        await lostNode(page, 'per:sax');
        expect(await nodeIds(page)).toContain('per:drums');
    });

    test('a guest edge is drawn as a credit, not as a membership', async ({ page }) => {
        // Half-alpha from the palette's GUEST_ON branch, and thinner. An
        // opaque colour here means the type-pair rules claimed it as
        // MEMBER_OF, and the graph is saying the saxophonist is in the band.
        await boot(page);

        const styles = await page.evaluate(() => {
            const out = {};
            window.musicGraph.ht.graph.eachNode((node) => {
                node.eachAdjacency((adj) => {
                    const type = adj.data?.type;
                    if (type !== 'MEMBER_OF' && type !== 'GUEST_ON') return;
                    out[type] = { color: adj.getData('color'), lineWidth: adj.getData('lineWidth') };
                });
            });
            return out;
        });

        expect(styles.GUEST_ON).toBeDefined();
        expect(styles.MEMBER_OF).toBeDefined();
        expect(styles.GUEST_ON.color).toMatch(/^rgba\(/);
        expect(styles.GUEST_ON.color).not.toBe(styles.MEMBER_OF.color);
        expect(styles.GUEST_ON.lineWidth).toBeLessThan(styles.MEMBER_OF.lineWidth);
    });

    test('a guest edge is navigable like any other', async ({ page }) => {
        await boot(page);

        await page.evaluate(() => {
            const g = window.musicGraph;
            g.handleNodeClick(g.ht.graph.getNode('grp:band'));
        });
        await page.waitForFunction(
            () => window.musicGraph.selectedNode?.id === 'grp:band' && !window.musicGraph.ht.busy
        );

        const targets = await page.evaluate(() =>
            window.musicGraph.edgeNavigator.candidates().map((c) => c.other.id).sort());
        expect(targets).toEqual(['per:drums', 'per:sax']);
    });
});

test.describe('technical credits', () => {
    test('start off, and the first request does not ask for them', async ({ page }) => {
        // They roughly double the person count on a well-credited release, and
        // they are credits on the object rather than connections between
        // musicians.
        const requested = await boot(page);

        await expect(page.locator('#show-technicians')).not.toBeChecked();
        expect(requested[0]).not.toContain('technicians=true');
        expect(await nodeIds(page)).not.toContain('per:sleeve');
    });

    test('ticking brings the sleeve designer in without losing the musicians', async ({ page }) => {
        await boot(page);
        await page.locator('#show-technicians').check();

        await hasNode(page, 'per:sleeve');
        expect(await nodeIds(page)).toEqual(['grp:band', 'per:drums', 'per:sax', 'per:sleeve']);
    });

    test('and unticking takes them away again', async ({ page }) => {
        await boot(page);
        await page.locator('#show-technicians').check();
        await hasNode(page, 'per:sleeve');

        await page.locator('#show-technicians').uncheck();
        await lostNode(page, 'per:sleeve');
    });

    test('the two toggles are independent', async ({ page }) => {
        // Technical credits on, musicians off: not a combination the UI
        // encourages, but a flag that quietly implied another would be worse.
        await boot(page);
        await page.locator('#show-technicians').check();
        await hasNode(page, 'per:sleeve');

        await page.locator('#show-musical-guests').uncheck();
        await lostNode(page, 'per:sax');
        expect(await nodeIds(page)).toContain('per:sleeve');
    });
});

test.describe('the bar and the menu', () => {
    test('stay in step with each other', async ({ page }) => {
        // Which one is on screen is a breakpoint away, and a half-ticked pair
        // is worse than either.
        await boot(page);

        await page.locator('#show-technicians').check();
        await hasNode(page, 'per:sleeve');
        await expect(page.locator('#menu-show-technicians')).toBeChecked();

        await page.locator('#show-musical-guests').uncheck();
        await lostNode(page, 'per:sax');
        await expect(page.locator('#menu-show-musical-guests')).not.toBeChecked();
    });

    test('and the menu starts on the same defaults as the bar', async ({ page }) => {
        await boot(page);

        await expect(page.locator('#menu-show-musical-guests')).toBeChecked();
        await expect(page.locator('#menu-show-technicians')).not.toBeChecked();
    });
});

test.describe('the toggles on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('are in the menu, where there is room to say what they do', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#show-musical-guests')).toBeHidden();
        await expect(page.locator('#show-technicians')).toBeHidden();

        await page.locator('#top-bar-menu-toggle').click();
        const menuBox = page.locator('#menu-show-technicians');
        await expect(menuBox).toBeVisible();

        await menuBox.check();
        await hasNode(page, 'per:sleeve');
    });

    test('and do not push anything off the side of the bar', async ({ page }) => {
        await boot(page);
        const overflowing = await page.evaluate(() => {
            const out = [];
            for (const selector of ['#nav-back', '#nav-forward', '#connect-wallet', '#top-bar-menu-toggle']) {
                const el = document.querySelector(selector);
                if (!el || el.offsetParent === null) continue;
                const rect = el.getBoundingClientRect();
                if (rect.right > window.innerWidth + 0.5 || rect.left < -0.5) out.push(selector);
            }
            return out;
        });
        expect(overflowing).toEqual([]);
    });
});
