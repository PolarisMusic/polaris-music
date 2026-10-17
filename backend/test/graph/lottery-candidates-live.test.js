/**
 * The lottery's candidate query, against a real Neo4j.
 *
 * This exists because the query is the one part of the draw a mock cannot
 * check, and because `SponsoredNodeService.getSponsoredNode()` swallows every
 * error by design — a drawn node is an enhancement, the graph opening at all
 * is not. So invalid Cypher here does not surface as a failure: it surfaces as
 * a front page that quietly stops opening on a drawn node, with one
 * `sponsored_node_unavailable` line in the log.
 *
 * The query is also not trivial. It is a UNION whose branches aggregate
 * differently — a group's provenance may come from its own created_at or from
 * its earliest SUBMITTED edge, which needs min() and therefore a
 * post-aggregation WHERE — and the two branches must agree on column names.
 *
 * SKIPS SILENTLY without GRAPH_URI, like every suite in this directory — so a
 * green local run is not evidence this ran. Check the skipped count. See
 * CLAUDE.md for why that warning is there and what shipped past it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import MusicGraphDatabase from '../../src/graph/schema.js';

const describeOrSkip = (process.env.GRAPH_URI && process.env.SKIP_GRAPH_TESTS !== 'true')
    ? describe : describe.skip;

const IDS = [
    'test:lottery:group:early', 'test:lottery:group:late',
    'test:lottery:group:bysubmit', 'test:lottery:group:undated',
    'test:lottery:group:merged', 'test:lottery:group:host',
    'test:lottery:person:early', 'test:lottery:person:late',
];
const ACCOUNT = 'test.lottery';

const EARLY = '2026-10-01T00:00:00Z';
const CUTOFF = '2026-10-10T00:00:00Z';
const LATE = '2026-10-20T00:00:00Z';

describeOrSkip('lottery candidates (live graph)', () => {
    let db;
    let session;

    beforeAll(async () => {
        db = new MusicGraphDatabase({
            uri: process.env.GRAPH_URI || 'bolt://127.0.0.1:7687',
            user: process.env.GRAPH_USER || 'neo4j',
            password: process.env.GRAPH_PASSWORD || 'password',
        });
    });

    afterAll(async () => {
        if (session) await session.close();
        if (db?.driver) await db.driver.close();
    });

    beforeEach(async () => {
        if (session) await session.close();
        session = db.driver.session();

        // Scoped to this suite's own ids rather than a wholesale wipe: the
        // destructive clean-up belongs to the suites that declare it.
        await session.run(`
            MATCH (n) WHERE n.group_id IN $ids OR n.person_id IN $ids
                OR n.account_id = $account
            DETACH DELETE n
        `, { ids: IDS, account: ACCOUNT });

        await session.run(`
            // A group that carries its own creation stamp, before the cutoff.
            CREATE (early:Group {group_id: 'test:lottery:group:early', id: 'test:lottery:group:early',
                name: 'Early', status: 'ACTIVE', created_at: datetime($early)})

            // The same, after it.
            CREATE (late:Group {group_id: 'test:lottery:group:late', id: 'test:lottery:group:late',
                name: 'Late', status: 'ACTIVE', created_at: datetime($late)})

            // No created_at — every group submitted before 2026-10-17 is this
            // shape — but a SUBMITTED edge that dates it.
            CREATE (bysubmit:Group {group_id: 'test:lottery:group:bysubmit',
                id: 'test:lottery:group:bysubmit', name: 'By Submission', status: 'ACTIVE'})
            CREATE (acct:Account {account_id: $account, id: $account})
            CREATE (acct)-[:SUBMITTED {event_hash: 'evt-early', timestamp: datetime($early)}]->(bysubmit)
            // A second, later submission must not move it: the first sighting
            // is what dates a node, so min() is the only correct aggregate.
            CREATE (acct)-[:SUBMITTED {event_hash: 'evt-late', timestamp: datetime($late)}]->(bysubmit)

            // Neither. Stays in the draw, counted as undated.
            CREATE (undated:Group {group_id: 'test:lottery:group:undated',
                id: 'test:lottery:group:undated', name: 'Undated', status: 'ACTIVE'})

            // A merged-away group, which is not a candidate, and whose id must
            // still come back as an alias of the node it merged into.
            CREATE (host:Group {group_id: 'test:lottery:group:host', id: 'test:lottery:group:host',
                name: 'Host', status: 'ACTIVE', created_at: datetime($early)})
            CREATE (merged:Group {group_id: 'test:lottery:group:merged',
                id: 'test:lottery:group:merged', name: 'Merged', status: 'MERGED',
                created_at: datetime($early)})
            CREATE (merged)-[:MERGED_INTO]->(host)

            // People are candidates only through membership.
            CREATE (pEarly:Person {person_id: 'test:lottery:person:early',
                id: 'test:lottery:person:early', name: 'Person Early', status: 'ACTIVE',
                created_at: datetime($early)})
            CREATE (pLate:Person {person_id: 'test:lottery:person:late',
                id: 'test:lottery:person:late', name: 'Person Late', status: 'ACTIVE',
                created_at: datetime($late)})
            CREATE (pEarly)-[:MEMBER_OF {claim_id: 'fixture'}]->(early)
            CREATE (pLate)-[:MEMBER_OF {claim_id: 'fixture'}]->(early)
        `, { account: ACCOUNT, early: EARLY, late: LATE });
    });

    /** Only this suite's rows, so a shared database does not confuse the counts. */
    const mine = (candidates) => candidates.filter(c => String(c.nodeId).startsWith('test:lottery:'));

    test('unbounded, every candidate is a candidate', async () => {
        const found = mine(await db.getLotteryCandidates());

        expect(found.map(c => c.nodeId).sort()).toEqual([
            'test:lottery:group:bysubmit',
            'test:lottery:group:early',
            'test:lottery:group:host',
            'test:lottery:group:late',
            'test:lottery:group:undated',
            'test:lottery:person:early',
            'test:lottery:person:late',
        ]);
    });

    test('a cutoff excludes what did not exist yet', async () => {
        // The bug this query was changed for: without the cutoff, a node
        // created today is in a draw whose snapshot was yesterday, and the
        // winner moves.
        const found = mine(await db.getLotteryCandidates(CUTOFF));

        expect(found.map(c => c.nodeId).sort()).toEqual([
            'test:lottery:group:bysubmit',
            'test:lottery:group:early',
            'test:lottery:group:host',
            'test:lottery:group:undated',
            'test:lottery:person:early',
        ]);
    });

    test('a group with no created_at is dated by its first submission', async () => {
        const [found] = mine(await db.getLotteryCandidates(CUTOFF))
            .filter(c => c.nodeId === 'test:lottery:group:bysubmit');

        // Two SUBMITTED edges, one before the cutoff and one after. The
        // earliest is what the node's existence is dated by.
        expect(found).toBeTruthy();
        expect(found.dated).toBe(true);
    });

    test('a candidate with no provenance stays in, marked undated', async () => {
        const [found] = mine(await db.getLotteryCandidates(CUTOFF))
            .filter(c => c.nodeId === 'test:lottery:group:undated');

        expect(found).toBeTruthy();
        expect(found.dated).toBe(false);
    });

    test('a dated candidate says so', async () => {
        const dated = mine(await db.getLotteryCandidates(CUTOFF))
            .filter(c => c.nodeId !== 'test:lottery:group:undated');

        expect(dated.every(c => c.dated === true)).toBe(true);
    });

    test('a merged group is not a candidate, but is an alias', async () => {
        const found = mine(await db.getLotteryCandidates(CUTOFF));

        expect(found.map(c => c.nodeId)).not.toContain('test:lottery:group:merged');
        const [host] = found.filter(c => c.nodeId === 'test:lottery:group:host');
        expect(host.aliasIds).toEqual(['test:lottery:group:merged']);
    });

    test('the order is the same every time', async () => {
        // The draw assigns each candidate a contiguous slice of the number
        // line in this order, so an unstable order is an unstable winner.
        const once = mine(await db.getLotteryCandidates(CUTOFF)).map(c => c.nodeId);
        const twice = mine(await db.getLotteryCandidates(CUTOFF)).map(c => c.nodeId);

        expect(twice).toEqual(once);
        expect([...once].sort()).toEqual(once);
    });

    test('a person who is nobody’s member is not a candidate', async () => {
        await session.run(`
            MATCH (p:Person {person_id: 'test:lottery:person:early'})-[m:MEMBER_OF]->()
            DELETE m
        `);

        const found = mine(await db.getLotteryCandidates(CUTOFF));

        expect(found.map(c => c.nodeId)).not.toContain('test:lottery:person:early');
    });
});
