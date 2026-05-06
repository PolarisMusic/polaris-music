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
export function createCurateRoutes({ store, config }) {
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

            const anchorsResp = await fetch(`${rpcUrl}/v1/chain/get_table_rows`, {
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

            // Fetch tallies for each anchor
            const operations = [];
            for (const anchor of rows) {
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
                    const tallyResp = await fetch(`${rpcUrl}/v1/chain/get_table_rows`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(tallyBody)
                    });
                    if (tallyResp.ok) {
                        const tallyData = await tallyResp.json();
                        tally = tallyData.rows && tallyData.rows[0] || null;
                    }
                } catch (e) {
                    // Tally fetch failure is non-fatal
                }

                // Try to get stored event summary from our event store
                let eventSummary = null;
                try {
                    const stored = await store.retrieveEvent(anchor.hash);
                    if (stored && stored.body) {
                        eventSummary = {
                            type_name: stored.type || null,
                            release_name: stored.body?.release?.name || null,
                            group_name: stored.body?.groups?.[0]?.name || null
                        };
                    }
                } catch (e) {
                    // Event retrieval is best-effort
                }

                operations.push({
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
                });
            }

            res.json({
                success: true,
                operations,
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
            const anchorsResp = await fetch(`${rpcUrl}/v1/chain/get_table_rows`, {
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

            if (!anchorsData.rows || anchorsData.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Anchor not found' });
            }

            const anchor = anchorsData.rows[0];

            // Fetch tally
            let tally = null;
            try {
                const tallyResp = await fetch(`${rpcUrl}/v1/chain/get_table_rows`, {
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
                const votesResp = await fetch(`${rpcUrl}/v1/chain/get_table_rows`, {
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
            let eventPayload = null;
            try {
                eventPayload = await store.retrieveEvent(anchor.hash);
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
                const found = votes.find(v => v.voter === viewerAccount);
                if (found) {
                    viewerVote = { val: found.val, weight: found.weight };
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
                    ts: anchor.ts || null,
                    finalized: !!anchor.finalized,
                    event_cid: anchor.event_cid || null
                },
                tally: tally ? {
                    up_weight: parseInt(tally.up_weight) || 0,
                    down_weight: parseInt(tally.down_weight) || 0,
                    up_voter_count: parseInt(tally.up_voter_count) || 0,
                    down_voter_count: parseInt(tally.down_voter_count) || 0,
                    updated_at: tally.updated_at
                } : { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 },
                viewer_vote: viewerVote,
                votes: votes.map(v => ({
                    voter: v.voter,
                    val: v.val,
                    weight: v.weight,
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
