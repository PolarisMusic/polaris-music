#!/usr/bin/env node
/**
 * @fileoverview Ingest an anchored event the chain sink has already passed.
 *
 * Ingestion writes the curation projection *before* it fetches the event body
 * (api/ingestion.js, "Step 2"), deliberately: the feed row describes what was
 * anchored on chain, which is true whether or not this host can read the body.
 * The graph write happens afterwards, and if it fails the endpoint answers 201
 * with `{status:'error'}`. The sink reports that as a rejection and moves on —
 * correctly, since an event that fails to process fails the same way every
 * time.
 *
 * Until the reason is fixed. Then the event is still anchored, its body is
 * still in storage, the feed still lists it, the cursor is long past it, and
 * nothing will ever try again. That is this script.
 *
 * It re-posts through the real endpoint rather than calling the handler
 * directly, so a replay goes through exactly what the sink goes through:
 * deduplication, projection, dispatch, the lot. Everything it sends comes from
 * the Operation projection the first attempt left behind.
 *
 * Usage, inside the api container (which has GRAPH_*, INGEST_API_KEY and the
 * API on localhost):
 *
 *   docker compose exec api node scripts/reingestEvent.js <event-hash> [...]
 *
 * Find the hash in the sink's log — it is the one on the ✗ Rejected line:
 *
 *   docker compose logs substreams-sink --since 24h | grep Rejected
 *
 * Environment: GRAPH_URI, GRAPH_USER, GRAPH_PASSWORD, INGEST_API_KEY, and
 * API_URL if the API is not on http://127.0.0.1:3000.
 */

import neo4j from 'neo4j-driver';

/** Where the API is, from inside its own container. */
const API_URL = process.env.API_URL || 'http://127.0.0.1:3000';

/**
 * Build the AnchoredEvent body from the projection the first attempt left.
 *
 * The same shape the sink posts. `tags` and `trx_id` are not projected and are
 * not read by anything that matters here: tags only reach the event metadata,
 * and the transaction id is carried for provenance in the log. Everything that
 * decides what gets written — the author, the type, the CID, the hash — is
 * stored on the Operation node.
 *
 * Exported and pure so it can be tested without a database or a network.
 *
 * @param {Object} operation - Row from the Operation projection.
 * @returns {Object} AnchoredEvent, ready to POST.
 */
export function anchoredEventFrom(operation) {
    const { eventHash, author, type, eventCid, parentHash, submittedAt, submittedBlock } = operation;
    if (!eventHash) throw new Error('An event hash is required');
    if (type == null) throw new Error(`No type recorded for ${eventHash}; nothing to dispatch`);

    return {
        content_hash: eventHash,
        payload: JSON.stringify({
            author: author ?? null,
            type: Number(type),
            hash: eventHash,
            event_cid: eventCid ?? null,
            parent: parentHash ?? null,
            // put()'s ts is in seconds; the projection stores milliseconds.
            ts: submittedAt ? Math.floor(submittedAt / 1000) : Math.floor(Date.now() / 1000),
            tags: [],
        }),
        contract_account: process.env.CONTRACT_ACCOUNT || 'polarismusic',
        action_name: 'put',
        trx_id: '',
        timestamp: submittedAt ? Math.floor(submittedAt / 1000) : Math.floor(Date.now() / 1000),
        block_num: submittedBlock ?? 0,
        block_id: '',
        action_ordinal: 0,
        // Named so the log says where a replayed event came from.
        source: 'reingest-script',
    };
}

/**
 * Read what the first attempt projected about this event.
 *
 * @param {Object} session
 * @param {string} eventHash
 * @returns {Promise<Object|null>}
 */
async function readOperation(session, eventHash) {
    const result = await session.run(`
        MATCH (o:Operation {event_hash: $eventHash})
        RETURN o.event_hash AS eventHash, o.author AS author, o.type AS type,
               o.event_cid AS eventCid, o.parent_hash AS parentHash,
               o.submitted_block AS submittedBlock,
               CASE WHEN o.submitted_at IS NULL THEN null
                    ELSE o.submitted_at.epochMillis END AS submittedAt
    `, { eventHash });

    const record = result.records[0];
    if (!record) return null;

    const plain = (value) => (neo4j.isInt(value) ? value.toNumber() : value);
    return {
        eventHash: record.get('eventHash'),
        author: record.get('author'),
        type: plain(record.get('type')),
        eventCid: record.get('eventCid'),
        parentHash: record.get('parentHash'),
        submittedBlock: plain(record.get('submittedBlock')),
        submittedAt: plain(record.get('submittedAt')),
    };
}

/**
 * @param {Object} anchoredEvent
 * @returns {Promise<Object>} The endpoint's answer.
 */
async function post(anchoredEvent) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.INGEST_API_KEY) headers['X-API-Key'] = process.env.INGEST_API_KEY;

    const response = await fetch(`${API_URL}/api/ingest/anchored-event`, {
        method: 'POST', headers, body: JSON.stringify(anchoredEvent),
    });
    const body = await response.json().catch(() => ({}));
    return { httpStatus: response.status, ...body };
}

async function main() {
    const hashes = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
    if (hashes.length === 0) {
        console.error('Usage: node scripts/reingestEvent.js <event-hash> [...]');
        return 2;
    }

    const driver = neo4j.driver(
        // 127.0.0.1, never localhost: the runbook documents an SSH tunnel on
        // 7687 and localhost can reach it, as backfillCreatedAt.js explains.
        process.env.GRAPH_URI || 'bolt://127.0.0.1:7687',
        neo4j.auth.basic(process.env.GRAPH_USER || 'neo4j',
            process.env.GRAPH_PASSWORD || 'polarisdev')
    );
    const session = driver.session();
    let failures = 0;

    try {
        for (const hash of hashes) {
            const operation = await readOperation(session, hash);
            if (!operation) {
                console.error(`✗ ${hash}: no Operation projected — nothing to replay from. `
                    + 'Was this event ever delivered to this host?');
                failures++;
                continue;
            }

            const result = await post(anchoredEventFrom(operation));
            // `status` is the application's answer; the HTTP code is 201 for
            // everything but a duplicate, which is why the sink reads the body.
            if (result.status === 'processed') {
                console.log(`✓ ${hash}: ingested (type ${operation.type})`);
            } else {
                console.error(`✗ ${hash}: ${result.status ?? result.httpStatus} `
                    + `${result.error ?? result.message ?? ''}`.trim());
                failures++;
            }
        }
    } finally {
        await session.close();
        await driver.close();
    }

    return failures === 0 ? 0 : 1;
}

// Only when run, not when imported: the helper above is unit-tested, and a test
// importing this file must not open a driver or post anything.
if (process.argv[1] && process.argv[1].endsWith('reingestEvent.js')) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error('reingest failed:', error.message);
            process.exit(1);
        });
}
