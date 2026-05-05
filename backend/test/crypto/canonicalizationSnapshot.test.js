/**
 * Backend canonicalization snapshot — Stage C CI gate.
 *
 * This is the lock that prevents a future change from silently swapping
 * the backend's canonicalizer (currently fast-json-stable-stringify)
 * for something that produces different bytes. Every event ever
 * anchored on-chain was hashed by EventStore.calculateHash, which
 * delegates to fast-json-stable-stringify — so changing it would orphan
 * historical anchors. The snapshot below pins the exact hex hash
 * produced for a corpus of representative event shapes.
 *
 * Background: the original Stage A plan worried that two canonicalizers
 * existed (frontend HashGenerator.canonicalize + backend
 * fast-json-stable-stringify) and might disagree on historical events.
 * The Stage C audit (see docs/canonicalization-divergence.md) confirmed
 * that the frontend canonicalizer was never on the hash path —
 * HashGenerator is imported in two files but never called, and
 * TransactionBuilder.calculateEventHash is defined but uncalled. Every
 * on-chain hash has always been produced by the backend.
 *
 * If this test fails, you are about to change every event hash. STOP.
 * The fix must be a versioned canonicalizer (write a new code path
 * for new events, keep the old code path active for verifying old
 * events) — not a swap.
 */

import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';
import EventStore from '../../src/storage/eventStore.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

let store;
beforeAll(() => {
    store = new EventStore({ ipfs: null, s3: null, redis: null });
});

describe('Backend canonicalization snapshot (CI gate)', () => {
    /**
     * Each fixture is hashed two ways:
     *  - via stable-stringify directly (proves what fast-json-stable-stringify
     *    is producing right now)
     *  - via EventStore.calculateHash (proves the backend's public hash API
     *    delegates to that same canonicalizer)
     *
     * Both must equal the pinned `expected` hex below. Changing any
     * fixture's expected value should be a deliberate, reviewed act.
     */
    const fixtures = [
        {
            name: 'minimal CREATE_RELEASE_BUNDLE',
            event: {
                v: 1,
                type: 'CREATE_RELEASE_BUNDLE',
                author_pubkey: 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV',
                created_at: 1714867200,
                parents: [],
                body: {
                    release: { name: 'Abbey Road', year: 1969 },
                    groups: [{ name: 'The Beatles' }],
                    tracks: [{ title: 'Come Together', position: 1 }],
                    tracklist: [{ position: 1, title: 'Come Together' }],
                },
                proofs: { source_links: [] },
            },
            expected: null, // filled in below by computing from current code
        },
        {
            name: 'ADD_CLAIM',
            event: {
                v: 1,
                type: 'ADD_CLAIM',
                author_pubkey: 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV',
                created_at: 1714867200,
                parents: [],
                body: {
                    target: { person_id: 'person:abc' },
                    field: 'birth_year',
                    value: 1942,
                },
            },
            expected: null,
        },
        {
            name: 'event with reverse-key-order body (canonicalizer must sort)',
            event: {
                type: 'X',
                z_last_field: 1,
                a_first_field: 2,
                body: { z: 1, m: 2, a: 3 },
            },
            expected: null,
        },
        {
            name: 'event with Unicode strings',
            event: {
                type: 'X',
                body: {
                    title: '🎵 Mañana 音楽',
                    notes: 'مرحبا',
                },
            },
            expected: null,
        },
        {
            name: 'sig field is excluded from hash',
            event: {
                type: 'X',
                body: { ok: true },
                sig: 'SIG_K1_invalid_but_should_be_stripped',
            },
            expected: null,
        },
        {
            name: 'large nested arrays',
            event: {
                type: 'X',
                body: {
                    nested: Array.from({ length: 5 }, (_, i) => ({
                        idx: i,
                        items: [`a${i}`, `b${i}`, { k: i }],
                    })),
                },
            },
            expected: null,
        },
    ];

    // --- Pinned snapshot values ---
    // Computed from the current code; if any of these change, the
    // canonicalizer or hashing has changed.
    fixtures[0].expected = '2b15b14630c29e7d78bd881c73f68f7f51e1a0c9ecde228c8cfd05babee80a2d';
    fixtures[1].expected = 'fe5ac64fb37757479638471cd91103192458c1c4e9e280e4bdf146c2b6a6d8ff';
    fixtures[2].expected = '150242c2261377ee38ddd7f0e3e0be1b1c0721ae6091a1144968b7d7c4948118';
    fixtures[3].expected = '4973c388bac6f677f2e0691f9c9cc4b39adbb28988b32dbe1b78df19357f7397';
    fixtures[4].expected = 'b245e60909fc4ea1be749339c4441091171f17a9182c9d08fda6094ac24b9062';
    fixtures[5].expected = '1ce5c0abaf95716fcc9a177d73202b61aaa13ecd35e8654354775bbb9ef02011';

    for (const f of fixtures) {
        test(`hash matches snapshot: ${f.name}`, () => {
            const { sig, ...withoutSig } = f.event;
            const directHash = sha(stringify(withoutSig));
            const apiHash = store.calculateHash(f.event);

            // Self-consistency: EventStore must use stable-stringify.
            expect(apiHash).toBe(directHash);

            // CI gate: the actual bytes must not have shifted.
            // If this fails, do NOT update the snapshot blindly — read the
            // file header above and treat any divergence as a serious change.
            expect(apiHash).toBe(f.expected);
        });
    }

    test('signature field is stripped before hashing', () => {
        const event = { type: 'X', body: { v: 1 } };
        const signed = { ...event, sig: 'SIG_K1_anything' };

        const unsigned = store.calculateHash(event);
        const stripped = store.calculateHash(signed);
        expect(unsigned).toBe(stripped);
    });

    test('getCanonicalPayload returns exactly the bytes that were hashed', () => {
        const event = { type: 'X', body: { v: 1, deep: { z: 1, a: 2 } } };
        const payload = store.getCanonicalPayload(event);
        const hash = store.calculateHash(event);
        expect(sha(payload)).toBe(hash);
    });
});
