/**
 * Passkeys as an Antelope signer.
 *
 * Antelope has had a native key type for this since the WEBAUTHN_KEY protocol
 * feature: a `PUB_WA_…` public key, whose signatures are produced by a
 * WebAuthn authenticator rather than by a secp256k1 key sitting in a wallet
 * app. Jungle4 has the feature activated (checked 2026-10-15), so the chain
 * will accept these signatures as authorisation like any other.
 *
 * What that buys is the login this project could not otherwise have. No wallet
 * to install, no seed phrase to lose, no email round trip, and no key for us to
 * hold — the private half never leaves the device's secure element, and the
 * visitor authorises with whatever unlocks their phone or laptop.
 *
 * Two things about WebAuthn shape everything here:
 *
 *  - **A credential is bound to a domain.** The relying party id is baked into
 *    the public key, and the chain checks it. A passkey enrolled on polaris.mu
 *    works on polaris.mu and nowhere else. That is the phishing resistance,
 *    and it is also why a key made against a test origin is a test key
 *    forever.
 *
 *  - **The authenticator signs a challenge of our choosing.** For a
 *    transaction that challenge is the signing digest, so the thing the
 *    visitor's fingerprint authorises is exactly the thing the chain verifies.
 *
 * This module is the plumbing: turning a browser credential into an Antelope
 * key, and an assertion into an Antelope signature. WalletPluginPasskey is the
 * SessionKit wallet built on it.
 *
 * @module wallet/passkey
 */

import { createPublic, createSignature, recoverPotentialPublicKeysFromAssertion }
    from '@wharfkit/webauthn';
import { PublicKey } from '@wharfkit/session';

/**
 * How long the browser's own prompt may sit there before giving up.
 *
 * Long enough to find a phone and look at it, short enough that a dialog
 * nobody is attending eventually closes rather than hanging the page.
 */
const CEREMONY_TIMEOUT_MS = 90_000;

/**
 * Is there an authenticator here at all?
 *
 * `window.PublicKeyCredential` is absent on browsers without WebAuthn, and
 * present-but-useless on a desktop with no platform authenticator and no
 * security key. The second case cannot be detected synchronously, so callers
 * that need certainty should ask
 * `isUserVerifyingPlatformAuthenticatorAvailable()`; this is the cheap check
 * for whether to offer the option at all.
 *
 * @returns {boolean}
 */
export function passkeysSupported() {
    return typeof window !== 'undefined'
        && typeof window.PublicKeyCredential === 'function'
        && !!window.navigator?.credentials?.create;
}

/**
 * Does this device have a built-in authenticator the visitor can actually use?
 *
 * @returns {Promise<boolean>}
 */
export async function platformAuthenticatorAvailable() {
    if (!passkeysSupported()) return false;
    try {
        return await window.PublicKeyCredential
            .isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
        return false;
    }
}

/**
 * The account name a passkey carries.
 *
 * WebAuthn hands the authenticator a `user.id` at registration and gives it
 * back, as `userHandle`, on every discoverable assertion. Putting the Antelope
 * account name there is what lets a visitor sign in without typing it: the
 * credential knows who it is for.
 *
 * Sixty-four bytes is the spec's limit for `user.id` and an Antelope name is at
 * most twelve characters, so there is no question of truncation.
 *
 * @param {string} accountName
 * @returns {Uint8Array}
 */
export function encodeUserHandle(accountName) {
    return new TextEncoder().encode(String(accountName));
}

/**
 * @param {ArrayBuffer|Uint8Array|null} handle
 * @returns {string|null}
 */
export function decodeUserHandle(handle) {
    if (!handle) return null;
    const bytes = handle instanceof Uint8Array ? handle : new Uint8Array(handle);
    if (bytes.length === 0) return null;
    return new TextDecoder().decode(bytes);
}

/**
 * Enrol a new passkey for an account, and return the Antelope key it produces.
 *
 * Creating the credential is only half of enrolment: the public key this
 * returns has to be added to the account's permission on chain before it can
 * authorise anything, which is a transaction somebody else has to sign — the
 * account's existing key, or the account creation that mints it. This function
 * does the browser half and says what the chain half needs.
 *
 * `residentKey: 'required'` is what makes the credential discoverable, which
 * is what makes the account name recoverable at login. Without it the visitor
 * would have to tell us who they are before we could ask the authenticator,
 * which is most of the friction this exists to remove.
 *
 * ES256 only, and not by preference: Antelope's WA keys are secp256r1, so an
 * authenticator that offered anything else would produce a key the chain
 * cannot represent.
 *
 * @param {Object} options
 * @param {string} options.accountName - the account this passkey will sign for
 * @param {string} options.appName     - shown in the browser's own prompt
 * @param {Uint8Array} [options.challenge] - defaults to fresh randomness
 * @returns {Promise<{publicKey: import('@wharfkit/antelope').PublicKey, credentialId: string}>}
 */
export async function enrolPasskey({ accountName, appName, challenge }) {
    if (!passkeysSupported()) {
        throw new Error('This browser has no passkey support');
    }

    const credential = await navigator.credentials.create({
        publicKey: {
            // Deliberately not set: `rp.id`. Left out, the browser uses the
            // current origin's effective domain, which is the only value that
            // can work anyway — naming it ourselves adds a way to get it
            // wrong, and a mismatch fails the ceremony rather than failing
            // later.
            rp: { name: appName },
            user: {
                id: encodeUserHandle(accountName),
                name: accountName,
                displayName: accountName,
            },
            // Registration's challenge is not a signing digest and proves
            // nothing on chain — the attestation is read locally for the key
            // alone. Random anyway, because a fixed one is a replay invitation
            // if attestation is ever checked remotely.
            challenge: challenge ?? crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: {
                residentKey: 'required',
                requireResidentKey: true,
                userVerification: 'required',
            },
            timeout: CEREMONY_TIMEOUT_MS,
            attestation: 'none',
        },
    });

    if (!credential) throw new Error('Passkey enrolment was dismissed');

    return {
        publicKey: createPublic(credential.response),
        credentialId: bytesToBase64Url(new Uint8Array(credential.rawId)),
    };
}

/**
 * Ask the authenticator to sign a challenge.
 *
 * With no `allowCredentials` the browser offers whatever discoverable
 * credentials it holds for this domain and returns the visitor's choice,
 * `userHandle` and all — which is the sign-in case. With one, it goes straight
 * to that credential, which is the signing case: by then we know whose
 * transaction this is and offering a different account would be a bug rather
 * than a convenience.
 *
 * @param {Object} options
 * @param {Uint8Array} options.challenge
 * @param {string} [options.credentialId] - base64url, from enrolment or login
 * @returns {Promise<AuthenticatorAssertionResponse & {rawId: ArrayBuffer}>}
 */
export async function assertPasskey({ challenge, credentialId }) {
    if (!passkeysSupported()) {
        throw new Error('This browser has no passkey support');
    }

    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge,
            userVerification: 'required',
            timeout: CEREMONY_TIMEOUT_MS,
            ...(credentialId
                ? {
                    allowCredentials: [{
                        type: 'public-key',
                        id: base64UrlToBytes(credentialId),
                    }],
                }
                : {}),
        },
    });

    if (!assertion) throw new Error('Passkey was dismissed');

    // rawId rides along because the sign-in path has to remember which
    // credential answered, and it is on the credential rather than on the
    // response.
    const response = assertion.response;
    response.rawId = assertion.rawId;
    return response;
}

/**
 * Which of an account's keys made this assertion.
 *
 * ECDSA lets a signature be recovered to a small set of candidate public keys
 * rather than one, so the assertion alone cannot say which key signed. The
 * account's own permissions settle it: exactly one candidate should be on the
 * account, and if none is, this passkey is not enrolled there.
 *
 * Doing it this way rather than remembering the key locally is what lets a
 * passkey synced to a new device sign in on it with nothing stored.
 *
 * @param {Object} assertionResponse
 * @param {Object} account - an account object from get_account
 * @returns {{publicKey: import('@wharfkit/antelope').PublicKey, permission: string}|null}
 */
export function matchAccountKey(assertionResponse, account) {
    const candidates = recoverPotentialPublicKeysFromAssertion(assertionResponse)
        .map(String);

    for (const permission of account?.permissions ?? []) {
        for (const keyWeight of permission.required_auth?.keys ?? []) {
            const key = String(keyWeight.key);
            if (candidates.includes(key)) {
                return { publicKey: key, permission: String(permission.perm_name) };
            }
        }
    }
    return null;
}

/**
 * Turn an assertion into an Antelope signature.
 *
 * The key is coerced rather than taken as given: createSignature reaches
 * straight into `publicKey.data.array` to recover the signature's recovery
 * byte, so a key held as a string — which is how a session stores it, because
 * that is what survives serialization — arrives as `undefined.array` and
 * throws from inside the library. Coercing here is cheap and puts the
 * requirement where the call is rather than at every call site.
 *
 * @param {string|import('@wharfkit/antelope').PublicKey} publicKey
 * @param {Object} assertionResponse
 * @returns {import('@wharfkit/antelope').Signature}
 */
export function signatureFromAssertion(publicKey, assertionResponse) {
    return createSignature(PublicKey.from(publicKey), assertionResponse);
}

/** @param {Uint8Array} bytes */
export function bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} value */
export function base64UrlToBytes(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
