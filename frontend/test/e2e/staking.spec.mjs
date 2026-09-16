/**
 * Staking from the node panel.
 *
 * Two things are worth guarding. The figure has to appear beside a node
 * whether or not anyone has staked on it — zero is a fact about the node, and
 * a blank is a fact about the connection, and the panel must not confuse them.
 * And the amount a person types has to reach the chain exactly: a stake is
 * money, and the digit a float loses is the one they are checking.
 */

import { test, expect } from '@playwright/test';

const GRAPH = {
    nodes: [
        { id: 'grp:band', name: 'Test Band', type: 'group' },
        { id: 'per:drums', name: 'A Drummer', type: 'person' },
    ],
    edges: [{ source: 'grp:band', target: 'per:drums', type: 'MEMBER_OF', role: 'drums' }],
};

const DETAILS = {
    'grp:band': { group_id: 'grp:band', name: 'Test Band' },
    'per:drums': { person_id: 'per:drums', name: 'A Drummer' },
};

/**
 * Boot with the graph stubbed and a chosen answer for the node-stake read.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 */
async function boot(page, { nodeStake = null, connected = true, stakeFails = false } = {}) {
    await page.route('**/api/**', (route) => {
        const url = decodeURIComponent(route.request().url());

        if (url.includes('/stake/node/')) {
            if (stakeFails) return route.fulfill({ status: 503, body: 'nope' });
            return route.fulfill({
                contentType: 'application/json',
                // The body is whatever the test named, verbatim: a stake
                // read that omits the symbol is a real case, and a helper that
                // quietly supplied one would hide it.
                body: JSON.stringify({ success: true, ...(nodeStake ?? {
                    symbol: 'MUS', precision: 4,
                    units: '0', formatted: '0.0000 MUS', stakerCount: 0,
                }) }),
            });
        }

        const match = Object.keys(DETAILS).find((id) => url.endsWith(`/${id}`));
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(match ? DETAILS[match] : {}),
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

    // Stand in for a signed-in wallet. The real one opens Anchor, which a
    // headless browser cannot complete, so the seam is the wallet manager
    // rather than the UI.
    await page.evaluate((isConnected) => {
        const sm = window.musicGraph.stakeManager;
        window.__sent = [];
        sm.walletManager = {
            isConnected: () => isConnected,
            getSession: () => ({
                actor: { toString: () => 'polaristest3' },
                permission: { toString: () => 'active' },
            }),
            transact: async (tx) => {
                window.__sent.push(tx);
                return { response: { transaction_id: 'deadbeef' } };
            },
        };
    }, connected);
}

/** Select a node the way a tap does, then wait for the panel to settle. */
async function selectNode(page, id) {
    await page.evaluate((nodeId) => {
        const g = window.musicGraph;
        g.handleNodeClick(g.ht.graph.getNode(nodeId));
    }, id);
    // Both halves matter: a missing .stake-total also satisfies "not the
    // placeholder", so waiting on that alone would return before the panel
    // had rendered at all and let a test read state the fetch has not reached.
    await page.waitForFunction(
        () => {
            const el = document.querySelector('.stake-total');
            return !!el && el.textContent !== '…';
        },
        { timeout: 10_000 }
    );
}

test.describe('the stake figure', () => {
    test('shows what is staked on the selected node', async ({ page }) => {
        await boot(page, { nodeStake: { units: '420000', formatted: '42.0000 MUS', stakerCount: 3 } });
        await selectNode(page, 'grp:band');

        await expect(page.locator('.stake-total')).toHaveText('42.0000 MUS');
        await expect(page.locator('.stake-backers')).toHaveText('from 3 backers');
    });

    test('an unstaked node shows zero, not a blank', async ({ page }) => {
        await boot(page);
        await selectNode(page, 'grp:band');

        await expect(page.locator('.stake-total')).toHaveText('0.0000 MUS');
        await expect(page.locator('.stake-backers')).toHaveText('from 0 backers');
    });

    test('one backer is singular', async ({ page }) => {
        await boot(page, { nodeStake: { units: '10000', formatted: '1.0000 MUS', stakerCount: 1 } });
        await selectNode(page, 'grp:band');

        await expect(page.locator('.stake-backers')).toHaveText('from 1 backer');
    });

    test('an unreachable backend says so rather than showing a false zero', async ({ page }) => {
        // Zero is a fact about the node; a failed read is a fact about the
        // connection. Showing the first for the second would tell someone
        // their stake had vanished.
        await boot(page, { stakeFails: true });
        await selectNode(page, 'grp:band');

        await expect(page.locator('.stake-total')).toHaveText('unavailable');
    });

    test('a person shows it too, since persons can be drawn', async ({ page }) => {
        await boot(page, { nodeStake: { units: '50000', formatted: '5.0000 MUS', stakerCount: 2 } });
        await selectNode(page, 'per:drums');

        await expect(page.locator('.stake-total')).toHaveText('5.0000 MUS');
    });
});

test.describe('placing a stake', () => {
    test('sends the exact amount typed, as a full-precision asset', async ({ page }) => {
        await boot(page);
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('10.5');
        await page.locator('.btn-stake').click();
        await expect(page.locator('.stake-status')).toContainText('Staked');

        const sent = await page.evaluate(() => window.__sent);
        expect(sent).toHaveLength(1);
        expect(sent[0].actions[0].name).toBe('stake');
        expect(sent[0].actions[0].data.quantity).toBe('10.5000 MUS');
        expect(sent[0].actions[0].data.account).toBe('polaristest3');
    });

    test('a fractional amount survives to the last unit', async ({ page }) => {
        // 0.0001 MUS is one unit. Through a float this is where it stops
        // being the number that was typed.
        await boot(page);
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('0.0001');
        await page.locator('.btn-stake').click();
        await expect(page.locator('.stake-status')).toContainText('Staked');

        const sent = await page.evaluate(() => window.__sent);
        expect(sent[0].actions[0].data.quantity).toBe('0.0001 MUS');
    });

    test('the node id is hashed to the identity the contract keys by', async ({ page }) => {
        // Must match sha256(node_id), or the stake lands under an identity
        // nothing reads.
        await boot(page);
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('1');
        await page.locator('.btn-stake').click();
        await expect(page.locator('.stake-status')).toContainText('Staked');

        const { sent, expected } = await page.evaluate(async () => {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('grp:band'));
            return {
                sent: window.__sent[0].actions[0].data.node_id,
                expected: Array.from(new Uint8Array(digest))
                    .map((b) => b.toString(16).padStart(2, '0')).join(''),
            };
        });
        expect(sent).toBe(expected);
    });

    test('unstake sends the unstake action', async ({ page }) => {
        await boot(page);
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('2');
        await page.locator('.btn-unstake').click();
        await expect(page.locator('.stake-status')).toContainText('Unstaked');

        const sent = await page.evaluate(() => window.__sent);
        expect(sent[0].actions[0].name).toBe('unstake');
    });

    test('a bad amount is refused before anything is signed', async ({ page }) => {
        await boot(page);
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('not a number');
        await page.locator('.btn-stake').click();

        await expect(page.locator('.stake-status')).toContainText('Enter an amount');
        expect(await page.evaluate(() => window.__sent.length)).toBe(0);
    });

    test('more decimals than the token holds is refused', async ({ page }) => {
        await boot(page);
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('1.234567');
        await page.locator('.btn-stake').click();

        await expect(page.locator('.stake-status')).toContainText('decimal places');
        expect(await page.evaluate(() => window.__sent.length)).toBe(0);
    });

    test('with no wallet there is a prompt instead of a form', async ({ page }) => {
        await boot(page, { connected: false });
        await selectNode(page, 'grp:band');

        await expect(page.locator('.stake-hint')).toContainText('Log in to stake');
        await expect(page.locator('.btn-stake')).toHaveCount(0);
    });
});

test.describe('the balance in the top bar', () => {
    /** Boot, then answer the account read with a chosen body. */
    async function bootWithBalance(page, { balance = null, status = 200, connected = true } = {}) {
        await boot(page, { connected });
        await page.route('**/api/stake/account/**', (route) => {
            if (status !== 200) return route.fulfill({ status, body: 'nope' });
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ success: true, ...balance }),
            });
        });
    }

    const FULL = {
        liquid: { units: '1234500', formatted: '123.4500 MUS' },
        staked: { units: '500000', formatted: '50.0000 MUS' },
        pending: { units: '0', formatted: '0.0000 MUS' },
    };

    /** Drive the same call the top bar makes, and read the same element. */
    const refresh = (page) => page.evaluate(() =>
        window.musicGraph.stakeManager.refreshBalanceInto(document.getElementById('user-balance')));

    test('shows liquid and staked for the signed-in account', async ({ page }) => {
        await bootWithBalance(page, { balance: FULL });
        await refresh(page);

        await expect(page.locator('#user-balance')).toHaveText('123.4500 MUS · 50.0000 MUS staked');
    });

    test('claimable is appended when there is something to claim', async ({ page }) => {
        await bootWithBalance(page, {
            balance: { ...FULL, pending: { units: '75000', formatted: '7.5000 MUS' } },
        });
        await refresh(page);

        await expect(page.locator('#user-balance'))
            .toHaveText('123.4500 MUS · 50.0000 MUS staked · 7.5000 MUS claimable');
    });

    test('the account read is scoped to the signed-in account', async ({ page }) => {
        await bootWithBalance(page, { balance: FULL });
        const [request] = await Promise.all([
            page.waitForRequest('**/api/stake/account/**'),
            refresh(page),
        ]);

        expect(request.url()).toContain('/api/stake/account/polaristest3');
    });

    test('an unreachable backend leaves the bar empty rather than erroring in the chrome', async ({ page }) => {
        await bootWithBalance(page, { status: 503 });
        await refresh(page);

        await expect(page.locator('#user-balance')).toHaveText('');
    });

    test('with no wallet nothing is read and nothing is shown', async ({ page }) => {
        await bootWithBalance(page, { balance: FULL, connected: false });
        let asked = false;
        await page.route('**/api/stake/account/**', (route) => { asked = true; route.fulfill({ status: 200, body: '{}' }); });
        await refresh(page);

        await expect(page.locator('#user-balance')).toHaveText('');
        expect(asked).toBe(false);
    });
});

test.describe('the symbol the chain declares', () => {
    // A bundle built today must not decide the precision of a symbol the
    // contract can change. The stake read carries the declaration; the form
    // builds its asset from that.

    test('an amount is denominated in the symbol the read reported', async ({ page }) => {
        await boot(page, { nodeStake: {
            symbol: 'POL', precision: 2, units: '4200', formatted: '42.00 POL', stakerCount: 1,
        } });
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('10.5');
        await page.locator('.btn-stake').click();
        await expect(page.locator('.stake-status')).toContainText('Staked');

        const sent = await page.evaluate(() => window.__sent);
        expect(sent[0].actions[0].data.quantity).toBe('10.50 POL');
    });

    test('decimals past that symbol are refused, in its own name', async ({ page }) => {
        await boot(page, { nodeStake: {
            symbol: 'POL', precision: 2, units: '0', formatted: '0.00 POL', stakerCount: 0,
        } });
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('1.234');
        await page.locator('.btn-stake').click();

        await expect(page.locator('.stake-status')).toContainText('POL holds at most 2 decimal places');
        expect(await page.evaluate(() => window.__sent.length)).toBe(0);
    });

    test('a symbol with no decimals takes no decimal point', async ({ page }) => {
        // "5. TOK" is not an asset the chain will unpack.
        await boot(page, { nodeStake: {
            symbol: 'TOK', precision: 0, units: '5', formatted: '5 TOK', stakerCount: 1,
        } });
        await selectNode(page, 'grp:band');

        await page.locator('.stake-amount').fill('5');
        await page.locator('.btn-stake').click();
        await expect(page.locator('.stake-status')).toContainText('Staked');

        const sent = await page.evaluate(() => window.__sent);
        expect(sent[0].actions[0].data.quantity).toBe('5 TOK');
    });

    test('a read that says nothing about the symbol leaves the default standing', async ({ page }) => {
        await boot(page, { nodeStake: { units: '0', formatted: '0.0000 MUS', stakerCount: 0 } });
        await page.evaluate(() => { window.musicGraph.stakeManager.token = { precision: 4, symbol: 'MUS' }; });
        await selectNode(page, 'grp:band');

        const token = await page.evaluate(() => window.musicGraph.stakeManager.token);
        expect(token).toEqual({ precision: 4, symbol: 'MUS' });
    });
});
