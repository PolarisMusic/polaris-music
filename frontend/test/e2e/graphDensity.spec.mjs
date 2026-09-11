/**
 * Two things that decide how busy the graph looks.
 *
 * Both were reported off the same screenshots: every node carrying its full
 * name at once, and edges heavy enough that a group with a dozen members
 * reads as a thicket.
 *
 * The label half is a regression net as much as a feature. The labels were
 * always meant to thin out toward the rim — placeNodeLabel() has gated on
 * Poincaré distance from the start — but the threshold is an absolute radius,
 * so anything that pulls the layout inward moves every node under it at once
 * and the gate silently stops gating. A non-zero JIT `offset` did exactly
 * that, which is half of why the offset was abandoned.
 *
 * Groups are exempt from the thinning: they are the landmarks you navigate
 * by, so their names run nearly to the rim while persons drop out early.
 */

import { test, expect } from '@playwright/test';

/**
 * Wide and deep enough that some nodes must land outside the label radius.
 * A small fixture would pass whatever the threshold was.
 */
const nodes = [
    { id: 'grp:band', name: 'Test Band', type: 'group' },
    { id: 'rel:one', name: 'Album One', type: 'release' },
];
const edges = [
    { source: 'grp:band', target: 'rel:one', type: 'PERFORMED_ON' },
];
for (let i = 0; i < 6; i++) {
    nodes.push({ id: `trk:${i}`, name: `Track ${i}`, type: 'track' });
    edges.push({ source: 'rel:one', target: `trk:${i}`, type: 'IN_RELEASE' });
    nodes.push({ id: `song:${i}`, name: `Song ${i}`, type: 'song' });
    edges.push({ source: `trk:${i}`, target: `song:${i}`, type: 'RECORDING_OF' });
    nodes.push({ id: `per:${i}`, name: `Writer ${i}`, type: 'person' });
    edges.push({ source: `song:${i}`, target: `per:${i}`, type: 'WROTE' });
}
for (let i = 0; i < 5; i++) {
    nodes.push({ id: `mem:${i}`, name: `Member ${i}`, type: 'person' });
    edges.push({ source: `mem:${i}`, target: 'grp:band', type: 'MEMBER_OF', role: 'guitar' });
}
// Side projects, hung off the members, so groups land at a spread of depths
// rather than all sitting on top of the root. A fixture with one group could
// not tell a group-specific rule from a depth-specific one.
for (let i = 0; i < 4; i++) {
    nodes.push({ id: `grp:side${i}`, name: `Side Project ${i}`, type: 'group' });
    edges.push({ source: `mem:${i}`, target: `grp:side${i}`, type: 'MEMBER_OF', role: 'bass' });
}
const GRAPH = { nodes, edges };

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * Boot with graph data stubbed in. The catch-all is registered first because
 * Playwright uses the LAST matching route, so registering it second would
 * shadow the graph stub.
 */
async function bootedGraph(page) {
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(GRAPH) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(
        () => window.musicGraph?.ht?.graph?.getNode?.(window.musicGraph.ht.root),
        { timeout: 15_000 }
    );
}

/** How many full-name tooltips are actually painted. */
const visibleLabels = (page) => page.evaluate(() =>
    [...document.querySelectorAll('.node-tooltip-label')]
        .filter((el) => el.style.display !== 'none' && el.offsetParent !== null)
        .length);

const nodeCount = (page) => page.evaluate(() => {
    let n = 0;
    window.musicGraph.ht.graph.eachNode(() => n++);
    return n;
});

test.describe('label density', () => {
    test.use({ viewport: DESKTOP });

    test('most nodes carry no label at rest', async ({ page }) => {
        await bootedGraph(page);

        const total = await nodeCount(page);
        const shown = await visibleLabels(page);

        // The specific fraction is tunable; "not all of them" is the claim.
        // With the threshold effectively disabled this was every node.
        expect(total).toBeGreaterThan(10);
        expect(shown).toBeLessThan(total / 2);
    });

    test('the centre keeps its labels', async ({ page }) => {
        // The other side of the same gate: thinning the rim must not blank the
        // graph. A threshold of 0 would pass the test above and be useless.
        await bootedGraph(page);
        expect(await visibleLabels(page)).toBeGreaterThan(0);
    });

    test('a node outside the radius is labelled once hovered', async ({ page }) => {
        await bootedGraph(page);

        // Pick a node the gate is actually hiding, rather than assuming which
        // one that is — the layout decides, and it changes with the offset.
        const hidden = await page.evaluate((threshold) => {
            let found = null;
            window.musicGraph.ht.graph.eachNode((node) => {
                if (found) return;
                if (node.pos.getc().squaredNorm() > threshold) found = node.id;
            });
            return found;
        }, await page.evaluate(() => window.musicGraph.labelProximityThreshold));

        expect(hidden).not.toBeNull();

        const labelShown = async (id) => page.evaluate((nodeId) => {
            const node = window.musicGraph.ht.graph.getNode(nodeId);
            const el = window.musicGraph.ht.labels.getLabel(nodeId);
            window.musicGraph.placeNodeLabel(el, node);
            return el.style.display !== 'none';
        }, id);

        expect(await labelShown(hidden)).toBe(false);

        await page.evaluate((nodeId) => {
            window.musicGraph.ht.graph.getNode(nodeId).setData('hoverTooltip', true);
        }, hidden);

        expect(await labelShown(hidden)).toBe(true);
    });
});

test.describe('which nodes keep their name', () => {
    test.use({ viewport: DESKTOP });

    test('a group keeps its label further out than a person would', async ({ page }) => {
        // The claim, stated as the rule rather than as a count: at some radius
        // a group is still labelled and a person in the same place is not.
        await bootedGraph(page);

        const { person, group } = await page.evaluate(() => ({
            person: window.musicGraph.labelProximityThreshold,
            group: window.musicGraph.groupLabelProximityThreshold,
        }));

        expect(group).toBeGreaterThan(person);
    });

    test('the threshold follows the node type, not the node', async ({ page }) => {
        // labelThresholdFor() is the whole mechanism; reading the two
        // properties above would pass on a build that never consulted them.
        await bootedGraph(page);

        const { forGroup, forPerson, groupThreshold, personThreshold } =
            await page.evaluate(() => {
                const mg = window.musicGraph;
                const get = (id) => mg.labelThresholdFor(mg.ht.graph.getNode(id));
                return {
                    forGroup: get('grp:side0'),
                    forPerson: get('mem:0'),
                    groupThreshold: mg.groupLabelProximityThreshold,
                    personThreshold: mg.labelProximityThreshold,
                };
            });

        expect(forGroup).toBe(groupThreshold);
        expect(forPerson).toBe(personThreshold);
    });

    test('a group out where persons have gone quiet is still named', async ({ page }) => {
        // The outcome the rule exists for, measured on the layout rather than
        // asserted from the constants: find a node sitting between the two
        // radii and check the gate treats it by type.
        await bootedGraph(page);

        const verdicts = await page.evaluate(() => {
            const mg = window.musicGraph;
            const shown = (node) => {
                const el = mg.ht.labels.getLabel(node.id);
                mg.placeNodeLabel(el, node);
                return el.style.display !== 'none';
            };

            const between = { group: null, person: null };
            mg.ht.graph.eachNode((node) => {
                const sq = node.pos.getc().squaredNorm();
                const inBand =
                    sq > mg.labelProximityThreshold &&
                    sq < mg.groupLabelProximityThreshold;
                if (!inBand || node.getData('isSelected')) return;

                const type = (node.data.type || '').toLowerCase();
                if (type === 'group' && between.group === null) {
                    between.group = shown(node);
                } else if (type !== 'group' && type !== 'root' && between.person === null) {
                    between.person = shown(node);
                }
            });
            return between;
        });

        // Both have to exist or the fixture is not exercising the band.
        expect(verdicts.group).toBe(true);
        expect(verdicts.person).toBe(false);
    });
});

test.describe('edge weight', () => {
    /** The width the palette hands JIT for the heaviest edge type. */
    const memberEdgeWidth = (page) => page.evaluate(() =>
        window.musicGraph.colorPalette.getEdgeWidth('MEMBER_OF'));

    test('desktop edges are lighter than the palette base', async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await bootedGraph(page);

        const base = await page.evaluate(() =>
            window.musicGraph.colorPalette.getBaseEdgeWidth('MEMBER_OF'));

        expect(await memberEdgeWidth(page)).toBeLessThan(base);
    });

    test('phone edges are lighter again, not merely lighter', async ({ page }) => {
        // "Significantly less on mobile" — so the phone has to be a clear step
        // below the desktop, not the same reduction applied twice.
        await page.setViewportSize(DESKTOP);
        await bootedGraph(page);
        const desktop = await memberEdgeWidth(page);

        await page.setViewportSize(PHONE);
        await bootedGraph(page);
        const phone = await memberEdgeWidth(page);

        expect(phone).toBeLessThan(desktop * 0.75);
        expect(phone).toBeGreaterThan(0);
    });

    test('the weights the edges are drawn with follow the palette', async ({ page }) => {
        // Reading the palette alone would pass on a build where styleEdge
        // ignored it. This reads what actually reached an adjacency.
        await page.setViewportSize(PHONE);
        await bootedGraph(page);

        const { drawn, expected } = await page.evaluate(() => {
            // eachAdjacency is a node method in JIT, not a graph one.
            let drawn = null;
            window.musicGraph.ht.graph.eachNode((node) => {
                node.eachAdjacency((adj) => {
                    if (drawn !== null) return;
                    const from = (adj.nodeFrom.data.type || '').toLowerCase();
                    const to = (adj.nodeTo.data.type || '').toLowerCase();
                    const isMembership =
                        (from === 'person' && to === 'group') ||
                        (from === 'group' && to === 'person');
                    if (isMembership) drawn = adj.getData('lineWidth');
                });
            });
            return {
                drawn,
                expected: window.musicGraph.colorPalette.getEdgeWidth('MEMBER_OF'),
            };
        });

        expect(drawn).toBeCloseTo(expected, 5);
    });
});
