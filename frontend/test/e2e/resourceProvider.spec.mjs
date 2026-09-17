/**
 * The resource provider, as the shipped bundle actually has it.
 *
 * The configuration is unit-tested off a browser; what this file guards is the
 * wiring, which is the half that fails quietly. A plugin that was configured
 * but never handed to SessionKit throws nothing, logs nothing, and shows up
 * only as a visitor reporting that their account has insufficient CPU.
 */

import { test, expect } from '@playwright/test';

const JUNGLE4 = '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d';

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

test.describe('the resource provider in the shipped bundle', () => {
    test('is registered as a transact plugin', async ({ page }) => {
        await boot(page);

        const ids = await page.evaluate(() =>
            window.walletManager.sessionKit.transactPlugins.map((p) => p.id));

        expect(ids).toContain('transact-plugin-resource-provider');
    });

    test('is pointed at an endpoint keyed by the chain the bundle runs on', async ({ page }) => {
        // The plugin looks its endpoint up by chain id and silently does
        // nothing when it finds none, so a mismatch here is invisible at
        // runtime.
        await boot(page);

        const { endpoints, chainId } = await page.evaluate(() => {
            const plugin = window.walletManager.sessionKit.transactPlugins
                .find((p) => p.id === 'transact-plugin-resource-provider');
            return {
                endpoints: plugin.endpoints,
                chainId: String(window.walletManager.config.chainId),
            };
        });

        expect(Object.keys(endpoints)).toEqual([chainId]);
        expect(chainId).toBe(JUNGLE4);
        expect(endpoints[chainId]).toBe('https://jungle4.greymass.com');
    });

    test('will not put a bill in front of a visitor', async ({ page }) => {
        // allowFees false means the free tier or nothing. The paid tier asks a
        // brand-new visitor to hand over tokens mid-transaction, which is the
        // moment they decide this is a scam.
        await boot(page);

        const allowFees = await page.evaluate(() =>
            window.walletManager.sessionKit.transactPlugins
                .find((p) => p.id === 'transact-plugin-resource-provider').allowFees);

        expect(allowFees).toBe(false);
    });

    test('the submit page gets it too, since that is where put() is pushed', async ({ page }) => {
        await page.route('**/api/**', (route) =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) }));
        await page.goto('/submit.html', { waitUntil: 'load' });
        // The submit page keeps its wallet on the app object rather than on
        // window, and builds its own WalletManager — a second construction that
        // would happily miss a plugin the graph page has.
        await page.waitForFunction(() => window.polarisApp?.walletManager?.sessionKit, { timeout: 15_000 });

        const ids = await page.evaluate(() =>
            window.polarisApp.walletManager.sessionKit.transactPlugins.map((p) => p.id));

        expect(ids).toContain('transact-plugin-resource-provider');
    });
});
