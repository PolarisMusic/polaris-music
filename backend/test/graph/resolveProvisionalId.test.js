/**
 * Honouring a provisional id the submitter picked from the typeahead.
 *
 * The picker in the submit form binds a hidden id input when the submitter
 * chooses an existing entity. That id used to be discarded: resolveEntityId
 * returned the submitted id only for canonical or external ids, and a
 * `prov:` id fell through to be regenerated from the fingerprint of the typed
 * name. Any divergence between the typed name and the stored one — a stray
 * space, an accent, Discogs' "(2)" suffix, which normalizeName strips — bound
 * the credit to a different node than the one the human chose.
 *
 * These tests drive a fake session, so they exercise the decision logic
 * without a database and never skip.
 */

import MusicGraphDatabase from '../../src/graph/schema.js';

/** Stand-in for a Neo4j result record. */
const record = (obj) => ({ keys: Object.keys(obj), get: (k) => obj[k] });

function fakeSession(handler) {
    return {
        calls: [],
        async run(cypher, params) {
            this.calls.push({ cypher, params });
            const rows = handler(cypher, params);
            if (rows instanceof Error) throw rows;
            return { records: (rows || []).map(record) };
        }
    };
}

/** A db instance with a silent logger and no driver. */
function makeDb() {
    const db = Object.create(MusicGraphDatabase.prototype);
    db.log = { debug() {}, info() {}, warn() {}, error() {} };
    return db;
}

describe('resolveProvisionalId', () => {
    it('returns the id when the node exists', async () => {
        const db = makeDb();
        const session = fakeSession(() => [{ resolvedId: 'prov:person:abc123' }]);
        await expect(db.resolveProvisionalId(session, 'person', 'prov:person:abc123'))
            .resolves.toBe('prov:person:abc123');
    });

    it('returns null when nothing carries that id', async () => {
        const db = makeDb();
        const session = fakeSession(() => []);
        await expect(db.resolveProvisionalId(session, 'person', 'prov:person:ghost'))
            .resolves.toBeNull();
    });

    it('follows a merge so a deduplicated pick lands on the survivor', async () => {
        const db = makeDb();
        const session = fakeSession(() => [{ resolvedId: 'prov:person:survivor' }]);
        await expect(db.resolveProvisionalId(session, 'person', 'prov:person:merged'))
            .resolves.toBe('prov:person:survivor');
    });

    it('queries the label and id field matching the entity type', async () => {
        const db = makeDb();
        const session = fakeSession(() => [{ resolvedId: 'prov:group:x' }]);
        await db.resolveProvisionalId(session, 'group', 'prov:group:x');
        expect(session.calls[0].cypher).toContain('(n:Group {group_id: $provisionalId})');
        expect(session.calls[0].params).toEqual({ provisionalId: 'prov:group:x' });
    });

    it('refuses an unknown entity type instead of interpolating it', async () => {
        // The label is taken from the SAFE_NODE_TYPES allowlist; an unknown
        // type must not reach the query string at all.
        const db = makeDb();
        const session = fakeSession(() => [{ resolvedId: 'x' }]);
        await expect(db.resolveProvisionalId(session, 'Claim) DETACH DELETE (n', 'prov:x:1'))
            .resolves.toBeNull();
        expect(session.calls).toHaveLength(0);
    });

    it('accepts a capitalized type, as SAFE_NODE_TYPES does', async () => {
        const db = makeDb();
        const session = fakeSession(() => [{ resolvedId: 'prov:release:r' }]);
        await expect(db.resolveProvisionalId(session, 'Release', 'prov:release:r'))
            .resolves.toBe('prov:release:r');
    });

    it('falls back to null rather than fabricating a binding when the lookup errors', async () => {
        const db = makeDb();
        const session = fakeSession(() => new Error('Neo.TransientError'));
        await expect(db.resolveProvisionalId(session, 'person', 'prov:person:abc'))
            .resolves.toBeNull();
    });
});

describe('resolveEntityId with a provisional id', () => {
    it('honours a picked id instead of regenerating from the typed name', async () => {
        const db = makeDb();
        const session = fakeSession(() => [{ resolvedId: 'prov:person:picked' }]);

        // The submitted name differs from the one the picked node was minted
        // from — exactly the case that used to silently fork the node.
        const resolved = await db.resolveEntityId(session, 'person', {
            person_id: 'prov:person:picked',
            name: 'John  Williams (2)'
        });

        expect(resolved).toBe('prov:person:picked');
    });

    it('mints from the fingerprint when the picked id names nothing', async () => {
        const db = makeDb();
        const session = fakeSession(() => []);

        const resolved = await db.resolveEntityId(session, 'person', {
            person_id: 'prov:person:stale',
            name: 'John Williams'
        });

        // Falls back to the deterministic fingerprint id, not the stale one.
        expect(resolved).not.toBe('prov:person:stale');
        expect(resolved).toBe(db.generateProvisionalIdNew('person', { name: 'John Williams' }));
    });

    it('still short-circuits on a canonical id without touching the graph', async () => {
        const db = makeDb();
        const session = fakeSession(() => []);
        const canonical = 'polaris:person:3f2504e0-4f89-41d3-9a0c-0305e82c3301';

        await expect(db.resolveEntityId(session, 'person', { person_id: canonical, name: 'X' }))
            .resolves.toBe(canonical);
        expect(session.calls).toHaveLength(0);
    });
});
