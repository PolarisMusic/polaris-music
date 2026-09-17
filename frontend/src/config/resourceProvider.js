/**
 * Who pays for a visitor's CPU and NET.
 *
 * Antelope bills the *first* authorizer of a transaction for its CPU and NET.
 * A resource provider exploits that: it prepends a `noop` action authorised by
 * its own account, signs it, and hands the transaction back — so the provider
 * is billed and the visitor's own signature on their own actions is untouched.
 * `require_auth(author)` inside `put()` still passes, because the author still
 * signed. Nothing about the permission model changes.
 *
 * What this does NOT do is move RAM. RAM is billed at the `emplace` call inside
 * the contract, which names the payer explicitly — `anchors.emplace(author, …)`
 * bills the author no matter who else signed. A provider can only help with RAM
 * by *buying* some for the account, which Greymass's service does behind its
 * fee tier. Account provisioning remains a separate problem; see
 * `docs/13-user-onboarding.md`.
 *
 * @module config/resourceProvider
 */

import { CHAIN_PROFILES } from '../../../shared/config/chainProfiles.js';

/**
 * Providers we know answer for a given chain.
 *
 * Keyed by profile rather than by chain id so a profile's chain id stays in one
 * place — `shared/config/chainProfiles.js` — and cannot drift from this map.
 * A profile absent from here has no provider, which is the honest answer for a
 * local single-node chain where nobody is offering to pay for anything.
 */
export const PROVIDER_BY_PROFILE = {
    jungle4: 'https://jungle4.greymass.com',
    mainnet: 'https://eos.greymass.com',
};

/**
 * Work out the resource-provider configuration for a build.
 *
 * Takes the environment rather than reading `import.meta.env` itself so the
 * decision is testable off a browser.
 *
 * @param {Record<string, string|undefined>} [env] - Vite's `import.meta.env`
 * @returns {{endpoints: Record<string,string>, allowFees: boolean, maxFee?: string}|null}
 *   null when no provider should be registered at all
 */
export function resolveResourceProvider(env = {}) {
    const profile = env.VITE_CHAIN_PROFILE || env.VITE_CHAIN_MODE || 'jungle4';

    // An explicit off switch, because "the site signs my transactions through
    // a third party" is a thing an operator may want to turn off without
    // rebuilding their reasoning about which profile implies what.
    if (String(env.VITE_RESOURCE_PROVIDER || '').toLowerCase() === 'off') return null;

    const url = env.VITE_RESOURCE_PROVIDER_URL || PROVIDER_BY_PROFILE[profile];
    if (!url) return null;

    const chainId = env.VITE_CHAIN_ID || CHAIN_PROFILES[profile]?.chainId;
    if (!chainId) return null;

    // Fees default OFF. The provider's free tier costs the visitor nothing; its
    // paid tier asks them to hand over tokens mid-transaction, which is exactly
    // the moment a new visitor decides this is a scam. Falling back to "your
    // account pays its own way" is a worse transaction and a better first
    // impression. An operator who has decided otherwise can set the flag.
    const allowFees = String(env.VITE_RESOURCE_PROVIDER_ALLOW_FEES || '') === 'true';

    const config = { endpoints: { [chainId]: url }, allowFees };

    // Only meaningful with fees on, but harmless otherwise, and a maxFee left
    // behind after someone flips fees off should not silently disappear.
    if (env.VITE_RESOURCE_PROVIDER_MAX_FEE) {
        config.maxFee = env.VITE_RESOURCE_PROVIDER_MAX_FEE;
    }

    return config;
}
