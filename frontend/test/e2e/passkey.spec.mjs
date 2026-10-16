/**
 * Signing in, and signing, with a passkey.
 *
 * Antelope has a native key type for this — `PUB_WA_…`, signed by a WebAuthn
 * authenticator rather than by a wallet app — and Jungle4 has the protocol
 * feature activated. What it buys is the login this project could not
 * otherwise offer: nothing to install, no seed phrase, no email, and no key
 * held by us.
 *
 * Chromium can be given a virtual authenticator over CDP, which is what makes
 * any of this testable: `navigator.credentials.create` and `.get` resolve
 * against software, with no fingerprint and no dialog, and produce the same
 * attestations and assertions a real device would.
 *
 * Everything here goes through the plugin's own login() and sign(), with the
 * chain stubbed and nothing else — a re-implementation of the crypto in the
 * test would only prove the test agrees with itself. The assertion that
 * matters is the last one: a signature checked against the digest it was made
 * over, by the library, in Node, outside the page that produced it. That is
 * the one saying the bytes a visitor's fingerprint authorises are bytes the
 * chain can verify.
 */

import { test, expect } from '@playwright/test';
import { ABIDecoder, Bytes, Checksum256, PublicKey, Signature } from '@wharfkit/antelope';
import { verifyPublic } from '@wharfkit/webauthn';

const JUNGLE4 = '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d';

/**
 * Served over https, at localhost, unlike every other spec here.
 *
 * Both halves are forced, and neither is about the code under test. A relying
 * party id must be a registrable domain, so the suite's 127.0.0.1 is refused
 * outright — "This is an invalid domain". And @wharfkit/webauthn reads the
 * origin out of the credential and throws "WebAuthn keys require https" for
 * anything else, because an Antelope PUB_WA_ key carries the relying party id
 * that the chain then checks: a key made over http is not a weaker key, it is
 * not a key.
 *
 * So this file alone runs against the second web server in the Playwright
 * config, with a certificate generated for the occasion. Everything else stays
 * on 127.0.0.1 over http.
 */
test.use({ baseURL: 'https://localhost:4443', ignoreHTTPSErrors: true });

/**
 * A software authenticator, attached to the page.
 *
 * `hasResidentKey` and `hasUserVerification` both matter: enrolment asks for a
 * discoverable credential with user verification, and an authenticator that
 * cannot do either fails the ceremony rather than quietly degrading.
 */
async function addAuthenticator(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
}

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

const enrol = (page, account) => page.evaluate(
    (name) => window.walletManager.enrolPasskey(name), account);

/**
 * Log in through the plugin, with the chain's answer supplied rather than
 * fetched. The account fixture is the only thing stubbed; the ceremony, the
 * userHandle and the key recovery are all the real path.
 */
const login = (page, permissions) => page.evaluate(async ({ chainId, perms }) => {
    const plugin = window.walletManager.sessionKit.walletPlugins
        .find((p) => p.id === 'passkey');
    const chain = { id: chainId };
    const context = {
        chain,
        chains: [chain],
        getClient: () => ({ v1: { chain: { get_account: async () => ({ permissions: perms }) } } }),
    };
    try {
        const result = await plugin.login(context);
        return { permissionLevel: String(result.permissionLevel), chain: String(result.chain) };
    } catch (error) {
        return { error: error.message };
    }
}, { chainId: JUNGLE4, perms: permissions });

/** Sign a digest through the plugin, after a login has set its data. */
const sign = (page, digestHex) => page.evaluate(async (hex) => {
    const plugin = window.walletManager.sessionKit.walletPlugins
        .find((p) => p.id === 'passkey');
    const { signatures } = await plugin.sign({ signingDigest: hex }, {});
    return String(signatures[0]);
}, digestHex);

/**
 * What a WebAuthn signature actually covers.
 *
 * Not the digest. The authenticator signs `authenticatorData ‖
 * SHA256(clientDataJSON)`, and the digest appears only as the `challenge`
 * field inside that JSON. Both pieces ride along in the Antelope signature
 * past its first 65 bytes, which is how the chain reconstructs the same
 * message — and how these tests can, from the signature alone.
 *
 * Getting this wrong is quiet: pass the digest as the message and every
 * verification fails, including the ones that are supposed to.
 */
function signedMessage(signature) {
    const decoder = new ABIDecoder(Signature.from(signature).data.array.subarray(65));
    const authenticatorData = Bytes.fromABI(decoder);
    const clientDataJSON = Bytes.fromABI(decoder);

    const message = new Bytes();
    message.append(authenticatorData);
    message.append(Checksum256.hash(clientDataJSON));
    return { message, clientDataJSON };
}

/** Is this signature cryptographically valid for this key? */
const verifies = (signature, publicKey) => verifyPublic(
    Signature.from(signature),
    signedMessage(signature).message,
    PublicKey.from(publicKey)
);

/** The digest the authenticator was asked to sign, as hex. */
function challengeOf(signature) {
    const { clientDataJSON } = signedMessage(signature);
    const { challenge } = JSON.parse(
        new TextDecoder().decode(clientDataJSON.array));
    return Buffer.from(challenge, 'base64url').toString('hex');
}

const activeOnly = (key) => [
    { perm_name: 'owner', required_auth: { keys: [] } },
    { perm_name: 'active', required_auth: { keys: [{ key, weight: 1 }] } },
];

test.describe('the passkey wallet', () => {
    test('is offered on a chain that can verify it', async ({ page }) => {
        await boot(page);
        const found = await page.evaluate(() => {
            const p = window.walletManager.sessionKit.walletPlugins
                .find((w) => w.id === 'passkey');
            return p ? (p.config.supportedChains ?? []).map(String) : null;
        });

        expect(found).not.toBeNull();
        expect(found.map((c) => c.toLowerCase())).toContain(JUNGLE4);
    });

    test('names itself in a way a stranger could act on', async ({ page }) => {
        // The login modal shows this and nothing else, and "Passkey" alone
        // assumes the visitor knows the word.
        await boot(page);
        const described = await page.evaluate(() => {
            const p = window.walletManager.sessionKit.walletPlugins
                .find((w) => w.id === 'passkey');
            return { name: p.metadata.name, description: p.metadata.description };
        });

        expect(described.name).toBe('Passkey');
        expect(described.description).toMatch(/fingerprint|face|device/i);
    });

    test('asks the visitor to choose neither chain nor permission', async ({ page }) => {
        // The credential already knows both, by being the thing enrolled on an
        // account. Asking would be asking them to repeat it.
        await boot(page);
        const config = await page.evaluate(() => {
            const p = window.walletManager.sessionKit.walletPlugins
                .find((w) => w.id === 'passkey');
            return { chain: p.config.requiresChainSelect, perm: p.config.requiresPermissionSelect };
        });
        expect(config).toEqual({ chain: false, perm: false });
    });
});

test.describe('enrolment', () => {
    test('produces an Antelope key of the WebAuthn type', async ({ page }) => {
        await addAuthenticator(page);
        await boot(page);

        const enrolled = await enrol(page, 'polaristest2');

        // PUB_WA_ is the whole point: a K1 key here would mean the credential
        // had been read as something the chain cannot represent.
        expect(enrolled.publicKey).toMatch(/^PUB_WA_/);
        expect(enrolled.credentialId).toBeTruthy();

        // Parsed by the library in Node, away from the page that made it.
        expect(String(PublicKey.from(enrolled.publicKey))).toBe(enrolled.publicKey);
    });

    test('refuses without an account to enrol against', async ({ page }) => {
        // The account name is not decoration: it becomes the userHandle, and
        // it is the only reason signing in needs nothing typed.
        await addAuthenticator(page);
        await boot(page);

        const error = await page.evaluate(async () => {
            try {
                await window.walletManager.enrolPasskey('');
                return null;
            } catch (e) { return e.message; }
        });
        expect(error).toMatch(/account name/i);
    });

    test('gives two enrolments two different keys', async ({ page }) => {
        // Each credential is its own keypair. If these ever matched, the
        // attestation was not being read.
        await addAuthenticator(page);
        await boot(page);

        const first = await enrol(page, 'polaristest2');
        const second = await enrol(page, 'polaristest3');
        expect(first.publicKey).not.toBe(second.publicKey);
    });
});

test.describe('signing in', () => {
    test('recovers the account and permission with nothing typed', async ({ page }) => {
        await addAuthenticator(page);
        await boot(page);
        const enrolled = await enrol(page, 'polaristest2');

        const result = await login(page, activeOnly(enrolled.publicKey));

        expect(result.error).toBeUndefined();
        expect(result.permissionLevel).toBe('polaristest2@active');
        expect(result.chain.toLowerCase()).toBe(JUNGLE4);
    });

    test('finds the permission the key is actually on, not the first one', async ({ page }) => {
        await addAuthenticator(page);
        await boot(page);
        const enrolled = await enrol(page, 'polaristest2');

        const result = await login(page, [
            { perm_name: 'active', required_auth: { keys: [] } },
            { perm_name: 'owner', required_auth: { keys: [{ key: enrolled.publicKey, weight: 1 }] } },
        ]);

        expect(result.permissionLevel).toBe('polaristest2@owner');
    });

    test('says so when the passkey is not on the account', async ({ page }) => {
        // Which key signed cannot be read off an assertion — ECDSA recovers a
        // small set of candidates — so the account's own permissions settle
        // it, and when none of them match, that is the answer.
        await addAuthenticator(page);
        await boot(page);
        await enrol(page, 'polaristest2');

        const result = await login(page, activeOnly(
            'PUB_K1_5AHoNnWetuDhKWSDx3WUf8W7Dg5xjHCMc4yHmmSiaJCFvvAgnB'));

        expect(result.permissionLevel).toBeUndefined();
        expect(result.error).toMatch(/not on polaristest2/i);
    });
});

test.describe('the signature', () => {
    test('verifies against the digest it was made over', async ({ page }) => {
        // The test this file exists for. Everything above is plumbing; this
        // says the bytes a visitor's fingerprint authorises are bytes that can
        // be verified against the key the chain would be holding.
        await addAuthenticator(page);
        await boot(page);
        const enrolled = await enrol(page, 'polaristest2');
        await login(page, activeOnly(enrolled.publicKey));

        // Stands in for a transaction's signingDigest, which by the time it
        // reaches the authenticator is just thirty-two bytes.
        const digest = Checksum256.hash(Bytes.from('polaris passkey test', 'utf8'));
        const signature = await sign(page, String(digest));

        expect(signature).toMatch(/^SIG_WA_/);

        // Two separate claims, and both are needed. That the signature is
        // valid for the key says a real authenticator made it; that its
        // challenge is this digest says it authorised this transaction and not
        // some other one the page could have slipped in.
        expect(verifies(signature, enrolled.publicKey)).toBe(true);
        expect(challengeOf(signature)).toBe(String(digest));
    });

    test('carries the digest it was made over, and no other', async ({ page }) => {
        // Guards the test above from passing on a verifier that says yes to
        // anything. Without it, a broken verifyPublic would read as a working
        // signer.
        await addAuthenticator(page);
        await boot(page);
        const enrolled = await enrol(page, 'polaristest2');
        await login(page, activeOnly(enrolled.publicKey));

        const digest = Checksum256.hash(Bytes.from('the real transaction', 'utf8'));
        const other = Checksum256.hash(Bytes.from('a different transaction', 'utf8'));
        const signature = await sign(page, String(digest));

        // Valid, and valid for exactly one thing.
        expect(verifies(signature, enrolled.publicKey)).toBe(true);
        expect(challengeOf(signature)).not.toBe(String(other));
    });

    test('does not verify against another passkey', async ({ page }) => {
        // The second credential is enrolled after the signing, so the login
        // above had exactly one discoverable credential to choose from and
        // there is nothing ambiguous about which key signed.
        await addAuthenticator(page);
        await boot(page);
        const mine = await enrol(page, 'polaristest2');
        await login(page, activeOnly(mine.publicKey));

        const digest = Checksum256.hash(Bytes.from('polaris passkey test', 'utf8'));
        const signature = await sign(page, String(digest));

        const theirs = await enrol(page, 'polaristest3');
        expect(theirs.publicKey).not.toBe(mine.publicKey);
        expect(verifies(signature, mine.publicKey)).toBe(true);
        expect(verifies(signature, theirs.publicKey)).toBe(false);
    });

    test('refuses to sign for a session that never logged in', async ({ page }) => {
        await addAuthenticator(page);
        await boot(page);
        await enrol(page, 'polaristest2');

        const error = await page.evaluate(async () => {
            const plugin = window.walletManager.sessionKit.walletPlugins
                .find((p) => p.id === 'passkey');
            try {
                await plugin.sign({ signingDigest: '00'.repeat(32) }, {});
                return null;
            } catch (e) { return e.message; }
        });
        expect(error).toMatch(/log in again/i);
    });
});
