/**
 * Who the site asks to pay for a visitor's CPU and NET.
 *
 * The decision is small but it is the kind that fails silently: a chain id
 * that does not match the endpoint's chain means the plugin finds no endpoint
 * and quietly does nothing, and the first anyone hears of it is a visitor
 * reporting "insufficient CPU". So the tests go after the mapping itself and
 * after the defaults that decide whether a visitor is ever shown a bill.
 */

import {
    resolveResourceProvider,
    PROVIDER_BY_PROFILE,
} from '../../../frontend/src/config/resourceProvider.js';
import { CHAIN_PROFILES } from '../../../shared/config/chainProfiles.js';

describe('choosing a resource provider', () => {
    test('jungle4 gets the jungle4 provider, keyed by jungle4 chain id', () => {
        const config = resolveResourceProvider({ VITE_CHAIN_PROFILE: 'jungle4' });

        expect(config.endpoints).toEqual({
            [CHAIN_PROFILES.jungle4.chainId]: 'https://jungle4.greymass.com',
        });
    });

    test('mainnet gets the mainnet provider, keyed by mainnet chain id', () => {
        const config = resolveResourceProvider({ VITE_CHAIN_PROFILE: 'mainnet' });

        expect(config.endpoints).toEqual({
            [CHAIN_PROFILES.mainnet.chainId]: 'https://eos.greymass.com',
        });
    });

    test('every endpoint is keyed by its own profile chain id, never another', () => {
        // The plugin looks the endpoint up by chain id. One id paired with
        // another chain's URL is not an error anywhere — it just never matches,
        // and the provider silently never runs.
        for (const profile of Object.keys(PROVIDER_BY_PROFILE)) {
            const config = resolveResourceProvider({ VITE_CHAIN_PROFILE: profile });
            expect(Object.keys(config.endpoints)).toEqual([CHAIN_PROFILES[profile].chainId]);
        }
    });

    test('a local chain has no provider, because nobody is offering', () => {
        expect(resolveResourceProvider({ VITE_CHAIN_PROFILE: 'local' })).toBeNull();
    });

    test('the legacy profile alias still selects a provider', () => {
        // VITE_CHAIN_MODE is honoured everywhere else in the config; a build
        // still using it must not silently lose its provider.
        const config = resolveResourceProvider({ VITE_CHAIN_MODE: 'jungle4' });
        expect(config.endpoints[CHAIN_PROFILES.jungle4.chainId]).toBe('https://jungle4.greymass.com');
    });

    test('no profile at all falls back to jungle4, matching chain.js', () => {
        const config = resolveResourceProvider({});
        expect(config.endpoints[CHAIN_PROFILES.jungle4.chainId]).toBe('https://jungle4.greymass.com');
    });
});

describe('fees', () => {
    test('are off unless someone turned them on', () => {
        // A visitor asked to hand over tokens mid-transaction concludes this is
        // a scam. The default must be the free tier or nothing.
        expect(resolveResourceProvider({ VITE_CHAIN_PROFILE: 'jungle4' }).allowFees).toBe(false);
    });

    test('turn on only for the exact string true', () => {
        const on = resolveResourceProvider({
            VITE_CHAIN_PROFILE: 'jungle4', VITE_RESOURCE_PROVIDER_ALLOW_FEES: 'true',
        });
        expect(on.allowFees).toBe(true);

        for (const value of ['false', '1', 'yes', 'TRUE', '']) {
            const off = resolveResourceProvider({
                VITE_CHAIN_PROFILE: 'jungle4', VITE_RESOURCE_PROVIDER_ALLOW_FEES: value,
            });
            expect(off.allowFees).toBe(false);
        }
    });

    test('a maximum is passed through when set, and absent when not', () => {
        const capped = resolveResourceProvider({
            VITE_CHAIN_PROFILE: 'jungle4', VITE_RESOURCE_PROVIDER_MAX_FEE: '0.5000 EOS',
        });
        expect(capped.maxFee).toBe('0.5000 EOS');

        expect(resolveResourceProvider({ VITE_CHAIN_PROFILE: 'jungle4' })).not.toHaveProperty('maxFee');
    });
});

describe('overrides', () => {
    test('a provider of our own replaces the hosted one', () => {
        // The path off Greymass's service and onto our own is a URL, not a
        // rewrite.
        const config = resolveResourceProvider({
            VITE_CHAIN_PROFILE: 'jungle4',
            VITE_RESOURCE_PROVIDER_URL: 'https://api.polaris.mu',
        });

        expect(config.endpoints).toEqual({
            [CHAIN_PROFILES.jungle4.chainId]: 'https://api.polaris.mu',
        });
    });

    test('a custom chain id keys the endpoint, not the profile default', () => {
        const config = resolveResourceProvider({
            VITE_CHAIN_PROFILE: 'jungle4',
            VITE_CHAIN_ID: 'f'.repeat(64),
            VITE_RESOURCE_PROVIDER_URL: 'https://example.invalid',
        });

        expect(config.endpoints).toEqual({ ['f'.repeat(64)]: 'https://example.invalid' });
    });

    test('off means off, even with a URL configured', () => {
        expect(resolveResourceProvider({
            VITE_CHAIN_PROFILE: 'jungle4',
            VITE_RESOURCE_PROVIDER: 'off',
            VITE_RESOURCE_PROVIDER_URL: 'https://api.polaris.mu',
        })).toBeNull();
    });

    test('off is case-insensitive, since this is typed into a .env by hand', () => {
        expect(resolveResourceProvider({
            VITE_CHAIN_PROFILE: 'jungle4', VITE_RESOURCE_PROVIDER: 'OFF',
        })).toBeNull();
    });

    test('a URL for a profile with no provider still registers one', () => {
        // Running a provider against a local chain is exactly how you test one.
        const config = resolveResourceProvider({
            VITE_CHAIN_PROFILE: 'local',
            VITE_RESOURCE_PROVIDER_URL: 'http://localhost:8080',
        });

        expect(config.endpoints).toEqual({
            [CHAIN_PROFILES.local.chainId]: 'http://localhost:8080',
        });
    });
});
