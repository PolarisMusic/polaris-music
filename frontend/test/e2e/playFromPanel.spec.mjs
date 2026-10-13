/**
 * Playing what a person or group played, from their own panel.
 *
 * The queue was already being fetched on every selection — and then nothing
 * revealed it. loadQueue defers while something is sounding and never expands
 * the player, deliberately: browsing the graph is not a request to change the
 * music. So there was a queue, correctly loaded, with no way to ask for it.
 *
 * The control is that request. It behaves like the track rows in a release
 * panel: it takes effect immediately, opens the player, and is honest that it
 * loads rather than plays — the Spotify embed is an iframe with no controller.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'Drummer', type: 'person' },
        { id: 'per:silent', name: 'Sleeve Designer', type: 'person' },
    ],
    edges: [
        { source: 'per:drums', target: 'grp:band', type: 'MEMBER_OF', role: 'drums' },
        { source: 'per:silent', target: 'grp:band', type: 'MEMBER_OF', role: 'design' },
    ],
};

/*
 * The shape the queue endpoint really returns: a `listen` object per track, and
 * it is optional. The third track has none on purpose — the registry is full of
 * them (hidden tracks, interludes, a track literally called "(silence)"), and
 * reading through a missing `listen` used to throw out of the player's display
 * and leave it half-loaded.
 */
const QUEUE = [
    {
        track_id: 'trk:1',
        title: 'First',
        listen: {
            can_inline_play: false,
            embed_uri: 'https://open.spotify.com/embed/track/aaa',
            preferred_link: 'https://open.spotify.com/track/aaa',
        },
    },
    {
        track_id: 'trk:2',
        title: 'Second',
        listen: {
            can_inline_play: false,
            embed_uri: 'https://open.spotify.com/embed/track/bbb',
            preferred_link: 'https://open.spotify.com/track/bbb',
        },
    },
    { track_id: 'trk:3', title: '(silence)' },
];

async function boot(page, { emptyFor = [], queue = QUEUE } = {}) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());

        if (url.includes('/player/queue')) {
            const empty = emptyFor.some((id) => url.includes(encodeURIComponent(id)) || url.includes(id));
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    context: { id: 'ctx', name: 'Test Band' },
                    queue: empty ? [] : queue,
                }),
            });
        }
        if (url.includes('/stake/')) {
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, units: '0', formatted: '0.0000 MUS', stakerCount: 0 }),
            });
        }
        const node = GRAPH.nodes.find((n) => url.endsWith(`/${n.id}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(node
                ? (node.type === 'group'
                    ? { group_id: node.id, name: node.name }
                    : { person_id: node.id, name: node.name })
                : {}),
        });
    });
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
    await page.waitForFunction(() => !window.musicGraph.ht.busy, { timeout: 15_000 });
}

async function select(page, id) {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    await page.waitForFunction(
        (nodeId) => window.musicGraph.selectedNode?.id === nodeId && !window.musicGraph.ht.busy,
        id,
        { timeout: 15_000 }
    );
}

const control = (page) => page.locator('.info-play-context');

test.describe('playing from a panel', () => {
    test('a group offers one', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await expect(control(page)).toBeVisible();
    });

    test('a person does too', async ({ page }) => {
        await boot(page);
        await select(page, 'per:drums');
        await expect(control(page)).toBeVisible();
    });

    test('it says it loads, not that it plays', async ({ page }) => {
        // The embed is an iframe with no controller; the visitor presses play
        // inside it. Claiming otherwise would be a lie, and the track rows in
        // a release panel already word it this way.
        await boot(page);
        await select(page, 'grp:band');
        await expect(control(page)).toHaveText(/load in player/i);
    });

    test('pressing it opens the player on the first track', async ({ page }) => {
        await boot(page);
        await select(page, 'grp:band');
        await control(page).click();

        // Waited for on the opening rather than on the queue. Selecting the
        // node loads the queue in the background on its own — deliberately,
        // and without opening anything — so a queue of three is satisfied
        // before the control's own fetch has returned and says nothing about
        // whether the control worked.
        await expect.poll(() => page.evaluate(
            () => window.musicGraph.miniPlayer?._collapsed)).toBe(false);
        expect(await page.evaluate(
            () => window.musicGraph.miniPlayer.queue.length)).toBe(3);
        expect(await page.evaluate(
            () => window.musicGraph.miniPlayer.currentIndex)).toBe(0);
    });

    test('and says so when there is nothing to play', async ({ page }) => {
        // Not knowable until it is asked for, and a control that silently does
        // nothing is worse than no control.
        await boot(page, { emptyFor: ['per:silent'] });
        await select(page, 'per:silent');
        await control(page).click();

        await expect(control(page)).toHaveText(/nothing to play/i);
        expect(await page.evaluate(
            () => window.musicGraph.miniPlayer._collapsed)).toBe(true);
    });

    test('selecting a node still does not open the player by itself', async ({ page }) => {
        // Browsing is not a request to change the music. The queue loads, the
        // player stays shut until asked.
        await boot(page);
        await select(page, 'grp:band');
        expect(await page.evaluate(
            () => window.musicGraph.miniPlayer._collapsed)).toBe(true);
    });

    test('a queue holding a track with no links does not break the player', async ({ page }) => {
        // The third fixture track has no `listen` at all. Reading through it
        // threw out of _updateTrackDisplay — after the queue had been applied
        // and the index moved — so the player was left half-loaded and this
        // control reported "nothing to play" about a queue of three tracks.
        await boot(page);
        await select(page, 'grp:band');
        await control(page).click();

        // Waited for rather than read: the control's handler fetches the queue
        // before the player can open, so reading _collapsed the instant after
        // the click caught an unsettled player. That failed only under the full
        // suite, where the round trip is slower — the assertion was right and
        // the moment it was made was wrong.
        await expect.poll(() => page.evaluate(
            () => window.musicGraph.miniPlayer?._collapsed)).toBe(false);
        await expect(control(page)).not.toHaveText(/nothing to play/i);

        // And stepping onto it is survivable too.
        await page.evaluate(() => {
            const mp = window.musicGraph.miniPlayer;
            mp.currentIndex = 2;
            mp._loadCurrentTrack(false);
        });
        expect(await page.evaluate(
            () => window.musicGraph.miniPlayer.currentIndex)).toBe(2);
    });

    test('and one whose very first track has no links still opens', async ({ page }) => {
        // The shape the production bug actually took: a context whose opening
        // track is the unlinked one, so the throw landed inside the open rather
        // than inside a later step. _loadCurrentTrack runs before expand(), so
        // the player was left shut with a queue of two sitting in it.
        await boot(page, { queue: [QUEUE[2], QUEUE[0]] });
        await select(page, 'grp:band');
        await control(page).click();

        await expect.poll(() => page.evaluate(
            () => window.musicGraph.miniPlayer?._collapsed)).toBe(false);
        expect(await page.evaluate(
            () => window.musicGraph.miniPlayer.queue.length)).toBe(2);
    });
});
