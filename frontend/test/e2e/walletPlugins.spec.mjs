/**
 * Which wallets the login modal can actually offer.
 *
 * CloudWallet was registered in WalletManager for years and could never have
 * worked here: its `supportedChains` holds exactly one entry, WAX mainnet,
 * while this app runs Jungle4 and EOS. WharfKit filters a plugin out of the
 * login modal when the current chain is not in that list, so the option was
 * unreachable — and silently so. Nothing threw, nothing logged, and the
 * deployment runbook told operators to log in with it at Phase 7.
 *
 * The removal is pinned here, but the general rule is the thing worth having:
 * a wallet plugin registered for a chain it does not support is a bug of this
 * exact shape whatever its name, and the shape is checkable.
 */

import { test, expect } from '@playwright/test';

async function boot(page) {
    await page.route('**/api/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) }));
    await page.route('**/graph/initial*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ nodes: [], edges: [] }) }));
    await page.route('**/graph/sponsored*', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, node: null }) }));

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.walletManager?.sessionKit, { timeout: 15_000 });
}

/** The wallet plugins the shipped bundle registers, with their chain limits. */
const registered = (page) => page.evaluate(() => ({
    chainId: String(window.walletManager.config.chainId).toLowerCase(),
    plugins: window.walletManager.sessionKit.walletPlugins.map((p) => ({
        id: p.id,
        name: p.metadata?.name ?? null,
        supportedChains: (p.config?.supportedChains ?? []).map((c) => String(c).toLowerCase()),
    })),
}));

test.describe('the wallets the bundle registers', () => {
    test('there is at least one, or nobody can sign anything', async ({ page }) => {
        await boot(page);
        const { plugins } = await registered(page);
        expect(plugins.length).toBeGreaterThan(0);
    });

    test('every one of them supports the chain the bundle runs on', async ({ page }) => {
        // A plugin with no supportedChains works everywhere and is fine. One
        // that names chains must name this one, or it is an option the modal
        // will never show.
        await boot(page);
        const { chainId, plugins } = await registered(page);

        const unusable = plugins.filter(
            (p) => p.supportedChains.length > 0 && !p.supportedChains.includes(chainId)
        );
        expect(unusable).toEqual([]);
    });

    test('Anchor is one of them', async ({ page }) => {
        // Not merely "a wallet exists": Anchor is the only wallet that works
        // on Jungle4 today, so its absence is the whole login flow gone.
        await boot(page);
        const { plugins } = await registered(page);
        expect(plugins.map((p) => p.id)).toContain('anchor');
    });

    test('CloudWallet is not', async ({ page }) => {
        await boot(page);
        const { plugins } = await registered(page);
        const names = plugins.map((p) => `${p.id} ${p.name ?? ''}`.toLowerCase()).join(' ');
        expect(names).not.toContain('cloudwallet');
        expect(names).not.toContain('cloud wallet');
    });
});
