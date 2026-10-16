/**
 * A SessionKit wallet backed by a passkey.
 *
 * The login this project could not otherwise offer: no wallet app, no seed
 * phrase, no email, and no key held by us. See `./passkey.js` for what
 * WebAuthn gives us and what it costs; this is the part SessionKit talks to.
 *
 * Signing in needs no account name typed in. The credential carries it —
 * `user.id` at enrolment comes back as `userHandle` on every assertion — and
 * which of the account's keys signed is settled by recovering candidates from
 * the signature and asking the chain which one the account actually holds.
 * Nothing is stored locally for that, so a passkey synced to a new device
 * signs in on it with no setup.
 *
 * @module wallet/WalletPluginPasskey
 */

import {
    AbstractWalletPlugin,
    Checksum256,
    PermissionLevel,
    WalletPluginMetadata,
} from '@wharfkit/session';

import {
    assertPasskey,
    decodeUserHandle,
    matchAccountKey,
    passkeysSupported,
    signatureFromAssertion,
    bytesToBase64Url,
} from './passkey.js';

export class WalletPluginPasskey extends AbstractWalletPlugin {
    /**
     * @param {Object} [options]
     * @param {string[]} [options.supportedChains] - chain ids this may be used on.
     *   Required in practice: the WEBAUTHN_KEY protocol feature has to be
     *   activated on the chain or the signature is not a signature, and a
     *   wallet offered where it cannot work is the CloudWallet mistake again.
     */
    constructor({ supportedChains } = {}) {
        super();

        this.config = {
            // The passkey itself decides which account and permission, by
            // being the thing enrolled on one. Asking the visitor to pick
            // either would be asking them to repeat what the credential
            // already knows.
            requiresChainSelect: false,
            requiresPermissionSelect: false,
            ...(supportedChains ? { supportedChains } : {}),
        };

        this.metadata = WalletPluginMetadata.from({
            name: 'Passkey',
            description: 'Sign in with the fingerprint, face or PIN that unlocks this device.',
            homepage: 'https://polaris.mu',
        });
    }

    get id() {
        return 'passkey';
    }

    /**
     * Sign in.
     *
     * @param {import('@wharfkit/session').LoginContext} context
     * @returns {Promise<import('@wharfkit/session').WalletPluginLoginResponse>}
     */
    async login(context) {
        if (!passkeysSupported()) {
            throw new Error('This browser cannot use passkeys');
        }

        const chain = context.chain ?? context.chains[0];
        if (!chain) throw new Error('No chain to log in to');

        // A login challenge authorises nothing on chain — there is no
        // transaction yet — so it only has to be unguessable, which is what
        // stops an assertion captured elsewhere being replayed at us.
        const assertion = await assertPasskey({
            challenge: crypto.getRandomValues(new Uint8Array(32)),
        });

        const accountName = decodeUserHandle(assertion.userHandle);
        if (!accountName) {
            throw new Error(
                'That passkey does not name an account. It was probably created '
                + 'for a different site, or before this one stored account names.'
            );
        }

        const account = await this._fetchAccount(context, chain, accountName);
        const matched = matchAccountKey(assertion, account);
        if (!matched) {
            throw new Error(
                `The passkey is not on ${accountName}. It may have been removed, `
                + 'or enrolled against a different account.'
            );
        }

        // Kept for signing: the credential so the authenticator is not asked
        // to offer a choice it has already made, and the key so a recovered
        // signature can be attributed without another chain lookup.
        this.data.accountName = accountName;
        this.data.permission = matched.permission;
        this.data.publicKey = matched.publicKey;
        this.data.credentialId = bytesToBase64Url(new Uint8Array(assertion.rawId));

        this.metadata.publicKey = matched.publicKey;

        return {
            chain: Checksum256.from(chain.id),
            permissionLevel: PermissionLevel.from(`${accountName}@${matched.permission}`),
        };
    }

    /**
     * Sign a transaction.
     *
     * The challenge handed to the authenticator is the transaction's own
     * signing digest, so what the visitor's fingerprint authorises and what
     * the chain verifies are the same bytes. There is no step in between where
     * a different transaction could be substituted.
     *
     * @param {import('@wharfkit/signing-request').ResolvedSigningRequest} resolved
     * @param {import('@wharfkit/session').TransactContext} context
     * @returns {Promise<import('@wharfkit/session').WalletPluginSignResponse>}
     */
    async sign(resolved, context) {
        const publicKey = this.data.publicKey;
        if (!publicKey) {
            throw new Error('This session has no passkey — log in again');
        }

        const digest = Checksum256.from(resolved.signingDigest);
        const assertion = await assertPasskey({
            challenge: digest.array,
            credentialId: this.data.credentialId,
        });

        return { signatures: [signatureFromAssertion(publicKey, assertion)] };
    }

    /**
     * The account's permissions, as the chain has them.
     *
     * Separated so the matching above can be read without the API call in the
     * way, and so a test can hand it an account without a chain.
     *
     * @private
     */
    async _fetchAccount(context, chain, accountName) {
        try {
            return await context.getClient(chain).v1.chain.get_account(accountName);
        } catch (error) {
            throw new Error(
                `Could not read ${accountName} from the chain: ${error.message}`
            );
        }
    }
}
