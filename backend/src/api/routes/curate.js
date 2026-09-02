/**
 * Curation endpoints — list anchored operations and their on-chain vote
 * tallies, plus full detail for a single operation.
 *
 * Mounted at /api/curate. Extracted from `api/server.js` (Stage I).
 *
 *   GET /api/curate/operations
 *   GET /api/curate/operations/:hash
 *
 * @module api/routes/curate
 */

import express from 'express';
import { sanitizeError } from '../../utils/errorSanitizer.js';

// Bounds for the operations listing. Without these the endpoint can hang
// indefinitely: Node's fetch has no default timeout, and eventStore performs
// an unbounded Redis -> IPFS -> S3 walk. An IPFS lookup for content this host
// cannot reach waits on a DHT search that may never resolve.
const RPC_TIMEOUT_MS = 5000;
const EVENT_LOOKUP_TIMEOUT_MS = 2000;

/**
 * fetch() with an enforced timeout.
 * Mirrors the AbortController pattern in utils/verifyChainId.js and
 * storage/pinningProvider.js.
 *
 * @param {string} url
 * @param {Object} [options] - fetch options
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolve a promise, or give up after timeoutMs and return `fallback`.
 * Used for best-effort lookups that must not stall the caller.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function withTimeout(promise, timeoutMs, fallback) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(fallback), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Parse type-specific detail from a stored event payload for rendering.
 * Pure function: returns a structured object the frontend can render
 * without deep knowledge of event internals.
 *
 * @param {Object|null|undefined} event - stored event payload
 * @returns {Object|null}
 */
export function parseOperationDetail(event) {
    if (!event || !event.body) return null;

    const typeCode = event.type;
    const body = event.body;

    if (typeCode === 21) {
        // CREATE_RELEASE_BUNDLE
        return {
            type: 'release_bundle',
            release: {
                name: body.release?.name || null,
                alt_names: body.release?.alt_names || [],
                release_date: body.release?.release_date || null,
                format: body.release?.format || null,
                liner_notes: body.release?.liner_notes || null,
                master_id: body.release?.master_id || null,
                album_art: body.release?.album_art || null,
                labels: (body.release?.labels || []).map(l => ({
                    name: l.name,
                    label_id: l.label_id || null,
                    parent_label: l.parent_label || null
                })),
                guests: (body.release?.guests || []).map(g => ({
                    name: g.name,
                    person_id: g.person_id || null,
                    roles: g.roles || []
                }))
            },
            groups: (body.groups || []).map(g => ({
                name: g.name,
                group_id: g.group_id || null,
                alt_names: g.alt_names || [],
                members: (g.members || []).map(m => ({
                    name: m.name,
                    person_id: m.person_id || null,
                    roles: m.roles || []
                }))
            })),
            tracks: (body.tracks || []).map(t => ({
                title: t.title,
                track_id: t.track_id || null,
                recording_of: t.recording_of || null,
                song_id: t.song_id || null,
                listen_links: t.listen_links || [],
                cover_of_song_id: t.cover_of_song_id || null,
                samples: t.samples || [],
                performed_by_groups: (t.performed_by_groups || []).map(g => ({
                    name: g.name,
                    group_id: g.group_id || null,
                    members: (g.members || []).map(m => ({
                        name: m.name,
                        person_id: m.person_id || null,
                        roles: m.roles || []
                    }))
                })),
                guests: (t.guests || []).map(g => ({
                    name: g.name,
                    person_id: g.person_id || null,
                    roles: g.roles || []
                })),
                producers: (t.producers || []).map(p => ({
                    name: p.name,
                    person_id: p.person_id || null,
                    roles: p.roles || []
                }))
            })),
            tracklist: body.tracklist || [],
            songs: (body.songs || []).map(s => ({
                title: s.title,
                song_id: s.song_id || null,
                writers: (s.writers || []).map(w => ({
                    name: w.name,
                    person_id: w.person_id || null,
                    roles: w.roles || []
                }))
            })),
            sources: body.sources || []
        };
    }

    if (typeCode === 30) {
        // ADD_CLAIM
        return {
            type: 'add_claim',
            target_type: body.target_type || null,
            target_id: body.target_id || null,
            field: body.field || null,
            value: body.value || null,
            source: body.source || null
        };
    }

    if (typeCode === 31) {
        // EDIT_CLAIM
        return {
            type: 'edit_claim',
            target_type: body.target_type || null,
            target_id: body.target_id || null,
            field: body.field || null,
            value: body.value || null,
            source: body.source || null
        };
    }

    // Fallback for other types
    return { type: `type_${typeCode}`, raw: body };
}

/**
 * @param {Object} ctx
 * @param {Object} ctx.store
 * @param {Object} ctx.config
 * @returns {express.Router}
 */
/**
 * Summarize a stored event body for a feed row, or null if it is not reachable.
 *
 * Timeboxed: retrieveEvent walks Redis -> IPFS -> S3 with no internal bound,
 * and an event this host has never stored sends it into an IPFS DHT search
 * that may never return. Listing an operation without its summary is the
 * honest representation of "anchored on chain, body not held here".
 *
 * @param {Object} store - Event store.
 * @param {string} hash - Event hash.
 * @returns {Promise<{type_name: string|null, release_name: string|null,
 *   group_name: string|null}|null>}
 */
async function loadEventSummary(store, hash) {
    try {
        const stored = await withTimeout(store.retrieveEvent(hash), EVENT_LOOKUP_TIMEOUT_MS, null);
        if (!stored?.body) return null;
        return {
            type_name: stored.type || null,
            release_name: stored.body?.release?.name || null,
            group_name: stored.body?.groups?.[0]?.name || null
        };
    } catch (e) {
        // Event retrieval is best-effort.
        return null;
    }
}

/**
 * Read a curation operation from the off-chain projection.
 *
 * The chain copy is transient by design: reclaim() erases the anchor, tally and
 * vote rows once curation is settled, because they are ~552, ~336 and ~461
 * bytes each billed to authors and voters, and nothing on chain reads them
 * again. This is where a reclaimed operation is read from afterwards.
 *
 * Returns null when the operation was never projected, which is the honest
 * answer for a hash that does not exist at all.
 *
 * @param {Object} db - Graph instance exposing a neo4j driver.
 * @param {string} hash - Event hash.
 * @returns {Promise<{hash: string, finalized: boolean, tally: Object,
 *   votes: Array}|null>}
 */
export async function loadProjectedOperation(db, hash) {
    if (!db?.driver || !hash) return null;

    const session = db.driver.session();
    try {
        const result = await session.run(`
            MATCH (o:Operation {event_hash: $hash})
            OPTIONAL MATCH (a:Account)-[v:VOTED]->(o)
            RETURN o,
                   collect(CASE WHEN a IS NULL THEN NULL
                                ELSE {voter: a.account_id, val: v.val, ts: v.voted_at} END) AS votes
        `, { hash });

        if (result.records.length === 0) return null;

        const record = result.records[0];
        const op = record.get('o').properties;
        const toInt = (v) => (v == null ? 0 : Number(v));

        return {
            hash,
            finalized: op.finalized === true,
            tally: {
                up_weight: toInt(op.up_weight),
                down_weight: toInt(op.down_weight),
                up_voter_count: toInt(op.up_voter_count),
                down_voter_count: toInt(op.down_voter_count),
                updated_at: op.finalized_at?.toString?.() ?? null
            },
            votes: record.get('votes')
                .filter(Boolean)
                .map(v => ({
                    voter: v.voter,
                    val: toInt(v.val),
                    // Respect-at-vote-time is not in any action trace, so a
                    // per-vote weight cannot be projected. The aggregate above
                    // is exact; this is honestly null rather than a guess.
                    weight: null,
                    ts: v.ts?.toString?.() ?? null
                }))
        };
    } finally {
        await session.close();
    }
}

/**
 * Read recent curation operations from the off-chain projection.
 *
 * The listing route's counterpart to loadProjectedOperation(): same node, same
 * vote edges, many rows instead of one. It exists because the feed reads the
 * chain's `anchors` table, and reclaim() deletes anchors — so once curation
 * settles, an operation that is still perfectly well recorded off-chain would
 * simply stop appearing.
 *
 * Only projections carrying an author are returned. An :Operation can be
 * created by a vote or finalize trace alone, which leaves a node with an
 * outcome and no identity; listing those would put blank rows in the feed.
 * ingestion.js projects every anchored submission with its author, so anything
 * genuinely submitted qualifies.
 *
 * @param {Object} db - Graph instance exposing a neo4j driver.
 * @param {number} limit - Maximum rows.
 * @param {number} [type] - Restrict to one event type, as ?type= does on the
 *   chain side. Filtered in the query rather than afterwards: taking the newest
 *   `limit` rows of every type and then filtering would return almost nothing
 *   for a narrow type while the chain half of the same feed returned a full page.
 * @returns {Promise<Array<Object>>} Feed-shaped rows, newest first.
 */
export async function listProjectedOperations(db, limit = 50, type = null) {
    if (!db?.driver) return [];

    const session = db.driver.session();
    try {
        const result = await session.run(`
            MATCH (o:Operation)
            WHERE o.author IS NOT NULL
              AND ($type IS NULL OR o.type = toInteger($type))
            RETURN o
            ORDER BY coalesce(o.submitted_at, o.finalized_at) DESC
            LIMIT toInteger($limit)
        `, { limit, type: Number.isFinite(Number(type)) && type !== null ? Number(type) : null });

        const toInt = (v) => (v == null ? 0 : Number(v));

        return result.records.map((record) => {
            const op = record.get('o').properties;
            const submittedAt = op.submitted_at ?? op.finalized_at ?? null;

            return {
                // No anchor_id: the chain row it came from may be gone, and
                // inventing an id would let the UI link to a table entry that
                // no longer exists. The hash is the stable identifier.
                anchor_id: null,
                author: op.author ?? null,
                type: toInt(op.type),
                hash: op.event_hash,
                event_cid: op.event_cid ?? null,
                // Seconds, matching the shape anchors.ts arrives in, so the
                // renderer sees one type of timestamp rather than two.
                ts: submittedAt?.toStandardDate
                    ? Math.floor(submittedAt.toStandardDate().getTime() / 1000)
                    : null,
                expires_at: null,
                finalized: op.finalized === true,
                tally: {
                    up_weight: toInt(op.up_weight),
                    down_weight: toInt(op.down_weight),
                    up_voter_count: toInt(op.up_voter_count),
                    down_voter_count: toInt(op.down_voter_count)
                },
                event_summary: null,
                // Lets the UI say why an operation has no anchor to act on:
                // reclaimed, not missing.
                reclaimed: true
            };
        });
    } finally {
        await session.close();
    }
}

export function createCurateRoutes({ store, config, db }) {
    const router = express.Router();

    /**
     * GET /api/curate/operations
     * Get recent anchored operations with on-chain vote tallies.
     * Reads anchors + votetally tables from the blockchain.
     *
     * Query params:
     *   limit (default 50)
     *   lower_bound (anchor id for pagination)
     *   type (filter by event type)
     */
    router.get('/operations', async (req, res) => {
        try {
            const rpcUrl = process.env.RPC_URL || config.rpcUrl;
            if (!rpcUrl) {
                return res.status(503).json({ success: false, error: 'RPC_URL not configured' });
            }

            const contractAccount = process.env.CONTRACT_ACCOUNT || 'polaris';
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const lower_bound = req.query.lower_bound || undefined;

            // Fetch anchors
            const anchorsBody = {
                json: true,
                code: contractAccount,
                scope: contractAccount,
                table: 'anchors',
                limit,
                reverse: true // newest first
            };
            if (lower_bound !== undefined) anchorsBody.lower_bound = lower_bound;

            const anchorsResp = await fetchWithTimeout(`${rpcUrl}/v1/chain/get_table_rows`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(anchorsBody)
            });
            if (!anchorsResp.ok) throw new Error(`Chain RPC error: ${anchorsResp.status}`);
            const anchorsData = await anchorsResp.json();

            // Filter by type if requested
            let rows = anchorsData.rows || [];
            if (req.query.type) {
                const filterType = parseInt(req.query.type);
                rows = rows.filter(r => r.type === filterType);
            }

            // Enrich each anchor with its tally and event summary.
            //
            // Concurrent, not sequential: this previously awaited two network
            // round-trips per anchor in a loop, so a 50-row page meant up to
            // 100 serial waits and a single slow lookup stalled the whole
            // response. Promise.all preserves input order in its result.
            const operations = await Promise.all(rows.map(async (anchor) => {
                const tallyBody = {
                    json: true,
                    code: contractAccount,
                    scope: contractAccount,
                    table: 'votetally',
                    limit: 1,
                    lower_bound: String(anchor.id),
                    upper_bound: String(anchor.id)
                };

                let tally = null;
                try {
                    const tallyResp = await fetchWithTimeout(`${rpcUrl}/v1/chain/get_table_rows`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(tallyBody)
                    });
                    if (tallyResp.ok) {
                        const tallyData = await tallyResp.json();
                        tally = tallyData.rows && tallyData.rows[0] || null;
                    }
                } catch (e) {
                    // Tally fetch failure (including timeout) is non-fatal
                }

                const eventSummary = await loadEventSummary(store, anchor.hash);

                return {
                    anchor_id: anchor.id,
                    author: anchor.author,
                    type: anchor.type,
                    hash: anchor.hash,
                    event_cid: anchor.event_cid,
                    ts: anchor.ts,
                    expires_at: anchor.expires_at,
                    finalized: anchor.finalized ? true : false,
                    tally: tally ? {
                        up_weight: parseInt(tally.up_weight) || 0,
                        down_weight: parseInt(tally.down_weight) || 0,
                        up_voter_count: parseInt(tally.up_voter_count) || 0,
                        down_voter_count: parseInt(tally.down_voter_count) || 0
                    } : { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 },
                    event_summary: eventSummary
                };
            }));

            // Merge in operations whose anchor has been reclaimed.
            //
            // Chain rows win on collision: while an anchor still exists it is
            // authoritative, and its tally is live where the projection's is a
            // snapshot taken at finalization. The projection only fills in what
            // the chain no longer has.
            const merged = new Map(operations.map(op => [String(op.hash).toLowerCase(), op]));
            // First page only. listProjectedOperations always returns the newest
            // rows, so merging it into a lower_bound page would repeat the same
            // reclaimed entries on every page rather than continuing past them.
            try {
                const projectedType = req.query.type ? parseInt(req.query.type) : null;
                const projected = (lower_bound !== undefined
                    ? []
                    : await listProjectedOperations(db, limit, projectedType))
                    .filter(op => !merged.has(String(op.hash).toLowerCase()));
                // The body outlives the anchor, so a reclaimed row can still
                // show what it was about — it should not read as less complete
                // than a live one just because the chain forgot it.
                await Promise.all(projected.map(async (op) => {
                    op.event_summary = await loadEventSummary(store, op.hash);
                    merged.set(String(op.hash).toLowerCase(), op);
                }));
            } catch (e) {
                // A graph that is down should degrade the feed to chain-only,
                // not fail it.
                console.warn('Curate projection listing failed:', e.message);
            }

            let allOperations = [...merged.values()];
            if (req.query.type) {
                const filterType = parseInt(req.query.type);
                allOperations = allOperations.filter(op => op.type === filterType);
            }
            allOperations.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
            allOperations = allOperations.slice(0, limit);

            res.json({
                success: true,
                operations: allOperations,
                more: anchorsData.more || false,
                next_key: anchorsData.next_key || null
            });
        } catch (error) {
            console.error('Curate operations failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/curate/operations/:hash
     * Get full details for a single anchored operation.
     * Returns anchor, tally, stored event payload, and individual votes.
     */
    router.get('/operations/:hash', async (req, res) => {
        try {
            const rpcUrl = process.env.RPC_URL || config.rpcUrl;
            if (!rpcUrl) {
                return res.status(503).json({ success: false, error: 'RPC_URL not configured' });
            }

            const contractAccount = process.env.CONTRACT_ACCOUNT || 'polaris';
            const hash = req.params.hash;

            // Fetch anchor by hash (secondary index)
            const anchorsResp = await fetchWithTimeout(`${rpcUrl}/v1/chain/get_table_rows`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    json: true,
                    code: contractAccount,
                    scope: contractAccount,
                    table: 'anchors',
                    index_position: 2, // byhash
                    key_type: 'sha256',
                    lower_bound: hash,
                    upper_bound: hash,
                    limit: 1
                })
            });
            if (!anchorsResp.ok) throw new Error(`Chain RPC error: ${anchorsResp.status}`);
            const anchorsData = await anchorsResp.json();

            // A missing anchor row is the expected steady state for a settled
            // operation, not an error: reclaim() erases it precisely because
            // nothing on chain needs it any more. Fall back to the projection.
            let projected = null;
            if (!anchorsData.rows || anchorsData.rows.length === 0) {
                projected = await loadProjectedOperation(db, hash);
                if (!projected) {
                    return res.status(404).json({ success: false, error: 'Anchor not found' });
                }
            }

            const anchor = anchorsData.rows?.[0] ?? {
                hash,
                id: null,
                // Reclaim is gated on finalization, so a reclaimed operation is
                // necessarily finalized.
                finalized: true,
                author: null,
                ts: null,
                event_cid: null,
                type: null
            };

            // Fetch tally
            let tally = null;
            try {
                const tallyResp = await fetchWithTimeout(`${rpcUrl}/v1/chain/get_table_rows`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        json: true,
                        code: contractAccount,
                        scope: contractAccount,
                        table: 'votetally',
                        limit: 1,
                        lower_bound: String(anchor.id),
                        upper_bound: String(anchor.id)
                    })
                });
                if (tallyResp.ok) {
                    const tallyData = await tallyResp.json();
                    tally = tallyData.rows?.[0] || null;
                }
            } catch (e) { /* non-fatal */ }

            // Fetch individual votes for this hash
            let votes = [];
            try {
                const votesResp = await fetchWithTimeout(`${rpcUrl}/v1/chain/get_table_rows`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        json: true,
                        code: contractAccount,
                        scope: contractAccount,
                        table: 'votes',
                        index_position: 3, // byhash
                        key_type: 'sha256',
                        lower_bound: hash,
                        upper_bound: hash,
                        limit: 200
                    })
                });
                if (votesResp.ok) {
                    const votesData = await votesResp.json();
                    votes = votesData.rows || [];
                }
            } catch (e) { /* non-fatal */ }

            // Fetch stored event payload
            // Timeboxed for the same reason as the listing: an event this host
            // never stored sends retrieveEvent into an unbounded IPFS lookup.
            let eventPayload = null;
            try {
                eventPayload = await withTimeout(
                    store.retrieveEvent(anchor.hash),
                    EVENT_LOOKUP_TIMEOUT_MS,
                    null
                );
            } catch (e) { /* non-fatal */ }

            // Parse type-specific detail for rendering
            const detail = parseOperationDetail(eventPayload);

            // Determine operation metadata
            const typeCode = eventPayload?.type || anchor.type || 0;
            const typeNames = {
                21: 'CREATE_RELEASE_BUNDLE', 30: 'ADD_CLAIM', 31: 'EDIT_CLAIM',
                40: 'VOTE', 41: 'LIKE', 50: 'FINALIZE', 60: 'MERGE_NODE'
            };

            // Check viewer's vote if account provided
            const viewerAccount = req.query.viewer;
            let viewerVote = null;
            if (viewerAccount && votes.length > 0) {
                const searchable = votes.length > 0 ? votes : (projected?.votes ?? []);
                const found = searchable.find(v => v.voter === viewerAccount);
                if (found) {
                    viewerVote = { val: found.val, weight: found.weight ?? null };
                }
            }

            res.json({
                success: true,
                operation: {
                    hash: anchor.hash,
                    anchor_id: anchor.id,
                    type_code: typeCode,
                    type_name: typeNames[typeCode] || `TYPE_${typeCode}`,
                    author: anchor.author || eventPayload?.author || null,
                    ts: anchor.ts || eventPayload?.ts || null,
                    finalized: !!anchor.finalized,
                    event_cid: anchor.event_cid || null
                },
                // Chain first while the rows exist; the projection once they
                // have been reclaimed. Zeros only when neither has anything,
                // which is a genuinely unvoted operation.
                tally: tally ? {
                    up_weight: parseInt(tally.up_weight) || 0,
                    down_weight: parseInt(tally.down_weight) || 0,
                    up_voter_count: parseInt(tally.up_voter_count) || 0,
                    down_voter_count: parseInt(tally.down_voter_count) || 0,
                    updated_at: tally.updated_at
                } : (projected?.tally
                    ?? { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 }),
                viewer_vote: viewerVote,
                votes: (votes.length > 0 ? votes : (projected?.votes ?? [])).map(v => ({
                    voter: v.voter,
                    val: v.val,
                    weight: v.weight ?? null,
                    ts: v.ts
                })),
                event: eventPayload,
                detail
            });
        } catch (error) {
            console.error('Curate operation detail failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return router;
}
