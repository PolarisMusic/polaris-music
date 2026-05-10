/**
 * Entity-detail REST endpoints (group, person, track, release, song, label).
 *
 * Mounted directly under /api. Extracted from `api/server.js` (Stage I).
 *
 *   GET /api/groups/:groupId/participation
 *   GET /api/groups/:groupId/details
 *   GET /api/group/:groupId
 *   GET /api/group/:groupId/releases
 *   GET /api/person/:personId
 *   GET /api/track/:trackId
 *   GET /api/release/:releaseId
 *   GET /api/song/:songId
 *   GET /api/label/:labelId
 *
 * @module api/routes/entities
 */

import express from 'express';
import { sanitizeError } from '../../utils/errorSanitizer.js';
import { safeClose } from '../../graph/safeTx.js';

/**
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {Object} ctx.config
 * @returns {express.Router}
 */
export function createEntityRoutes({ db, config }) {
    const router = express.Router();

    /**
     * GET /api/groups/:groupId/participation
     * Get member participation data for RGraph visualization
     */
    router.get('/groups/:groupId/participation', async (req, res) => {
        const groupId = req.params.groupId;
        const startMs = Date.now();
        try {
            const rows = await db.calculateGroupMemberParticipation(groupId);

            // rows is a flat array; totalTracks is the same on every row
            const totalTracks = rows.length > 0 ? rows[0].totalTracks : 0;
            const members = rows.map(r => ({
                personId: r.personId,
                personName: r.personName,
                trackCount: r.trackCount,
                trackPctOfGroupTracks: r.trackPctOfGroupTracks,
                color: r.color ?? null
            }));

            const durationMs = Date.now() - startMs;
            console.log(`Participation request: group=${groupId.substring(0, 12)} members=${members.length} duration=${durationMs}ms`);

            res.json({
                success: true,
                groupId,
                totalTracks,
                members
            });
        } catch (error) {
            const durationMs = Date.now() - startMs;
            console.error(`Participation request failed: group=${groupId.substring(0, 12)} duration=${durationMs}ms`, error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/person/:personId
     * Get person details
     */
    router.get('/person/:personId', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (p:Person {person_id: $personId})
                    OPTIONAL MATCH (p)-[m:MEMBER_OF]->(g:Group)
                    OPTIONAL MATCH (p)-[:WROTE]->(s:Song)
                    OPTIONAL MATCH (p)-[:GUEST_ON]->(t:Track)

                    RETURN p,
                           collect(DISTINCT {
                               group: g.name,
                               group_id: g.group_id,
                               role: m.role,
                               from_date: m.from_date,
                               to_date: m.to_date
                           }) as groups,
                           count(DISTINCT s) as songsWritten,
                           count(DISTINCT t) as guestAppearances
                `, { personId: req.params.personId });

                if (result.records.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Person not found'
                    });
                }

                const record = result.records[0];
                const person = record.get('p').properties;

                res.json({
                    success: true,
                    data: {
                        ...person,
                        groups: record.get('groups').filter(g => g.group !== null),
                        songsWritten: record.get('songsWritten').toNumber(),
                        guestAppearances: record.get('guestAppearances').toNumber()
                    }
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Person details failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/group/:groupId
     * Get group details
     */
    router.get('/group/:groupId', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (g:Group {group_id: $groupId})
                    OPTIONAL MATCH (g)-[:PERFORMED_ON]->(t:Track)
                    OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                    OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)

                    RETURN g,
                           count(DISTINCT t) as trackCount,
                           count(DISTINCT r) as releaseCount,
                           collect(DISTINCT {
                               person: p.name,
                               person_id: p.person_id,
                               role: m.role,
                               from_date: m.from_date,
                               to_date: m.to_date
                           }) as members
                `, { groupId: req.params.groupId });

                if (result.records.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Group not found'
                    });
                }

                const record = result.records[0];
                const group = record.get('g').properties;

                res.json({
                    success: true,
                    data: {
                        ...group,
                        trackCount: record.get('trackCount').toNumber(),
                        releaseCount: record.get('releaseCount').toNumber(),
                        members: record.get('members').filter(m => m.person !== null)
                    }
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Group details failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/group/:groupId/releases
     * Get releases associated with a group (for release orbit overlay)
     */
    router.get('/group/:groupId/releases', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (g:Group {group_id: $groupId})
                    MATCH (g)-[:PERFORMED_ON]->(t:Track)-[:IN_RELEASE]->(r:Release)
                    WITH g, r, count(DISTINCT t) as trackCount
                    OPTIONAL MATCH (guest:Person)-[:GUEST_ON]->(gt:Track)-[:IN_RELEASE]->(r)
                    WHERE NOT (guest)-[:MEMBER_OF]->(g)
                    WITH r, trackCount, count(DISTINCT guest) as guestCount
                    RETURN r.release_id as release_id,
                           r.name as name,
                           r.release_date as release_date,
                           r.album_art as album_art,
                           r.format as format,
                           r.master_id as master_id,
                           trackCount as track_count,
                           guestCount as guest_count
                    ORDER BY r.release_date ASC, r.name ASC
                `, { groupId: req.params.groupId });

                const releases = result.records.map(rec => ({
                    release_id: rec.get('release_id'),
                    name: rec.get('name'),
                    release_date: rec.get('release_date'),
                    album_art: rec.get('album_art'),
                    format: rec.get('format'),
                    master_id: rec.get('master_id'),
                    track_count: typeof rec.get('track_count')?.toNumber === 'function'
                        ? rec.get('track_count').toNumber() : rec.get('track_count'),
                    guest_count: typeof rec.get('guest_count')?.toNumber === 'function'
                        ? rec.get('guest_count').toNumber() : rec.get('guest_count')
                }));

                res.json({
                    success: true,
                    groupId: req.params.groupId,
                    releases
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Group releases failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/release/:releaseId
     * Get release details (includes tracks, labels, groups, and guests).
     *
     * Issues 3 sequential session.run() calls (main, groups, guests) — call
     * order is contract-locked by the H snapshot test.
     */
    router.get('/release/:releaseId', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                // Main release + tracks + labels
                const result = await session.run(`
                    MATCH (r:Release {release_id: $releaseId})
                    OPTIONAL MATCH (t:Track)-[ir:IN_RELEASE]->(r)
                    OPTIONAL MATCH (r)-[:RELEASED]->(l:Label)

                    RETURN r,
                           collect(DISTINCT {
                               track: t.title,
                               track_id: t.track_id,
                               disc_number: ir.disc_number,
                               track_number: ir.track_number,
                               side: ir.side
                           }) as tracks,
                           collect(DISTINCT {
                               label: l.name,
                               label_id: l.label_id
                           }) as labels
                `, { releaseId: req.params.releaseId });

                if (result.records.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Release not found'
                    });
                }

                const record = result.records[0];
                const release = record.get('r').properties;

                // Groups that performed on this release
                const groupResult = await session.run(`
                    MATCH (t:Track)-[:IN_RELEASE]->(:Release {release_id: $releaseId})
                    MATCH (g:Group)-[:PERFORMED_ON]->(t)
                    RETURN DISTINCT g.group_id as group_id, g.name as name
                `, { releaseId: req.params.releaseId });

                const groups = groupResult.records.map(r => ({
                    group_id: r.get('group_id'),
                    name: r.get('name')
                }));

                // Guests: persons credited via GUEST_ON on tracks in this release
                const guestResult = await session.run(`
                    MATCH (t:Track)-[:IN_RELEASE]->(:Release {release_id: $releaseId})
                    MATCH (p:Person)-[go:GUEST_ON]->(t)
                    WITH p, collect(DISTINCT coalesce(go.role, go.instrument, '')) as roles
                    RETURN p.person_id as person_id,
                           p.name as name,
                           p.color as color,
                           roles
                `, { releaseId: req.params.releaseId });

                const guests = guestResult.records.map(r => ({
                    person_id: r.get('person_id'),
                    name: r.get('name'),
                    color: r.get('color'),
                    roles: r.get('roles').filter(Boolean)
                }));

                res.json({
                    success: true,
                    data: {
                        ...release,
                        tracks: record.get('tracks').filter(t => t.track !== null),
                        labels: record.get('labels').filter(l => l.label !== null),
                        groups,
                        guests
                    }
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Release details failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/track/:trackId
     * Get track details
     */
    router.get('/track/:trackId', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (t:Track {track_id: $trackId})
                    OPTIONAL MATCH (t)-[:RECORDING_OF]->(s:Song)
                    OPTIONAL MATCH (g:Group)-[:PERFORMED_ON]->(t)
                    OPTIONAL MATCH (p:Person)-[:GUEST_ON]->(t)
                    OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)

                    RETURN t,
                           s,
                           collect(DISTINCT {
                               group: g.name,
                               group_id: g.group_id
                           }) as performedBy,
                           collect(DISTINCT {
                               guest: p.name,
                               person_id: p.person_id
                           }) as guests,
                           collect(DISTINCT {
                               release: r.name,
                               release_id: r.release_id
                           }) as releases
                `, { trackId: req.params.trackId });

                if (result.records.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Track not found'
                    });
                }

                const record = result.records[0];
                const track = record.get('t').properties;
                const song = record.get('s');

                res.json({
                    success: true,
                    data: {
                        ...track,
                        song: song ? song.properties : null,
                        performedBy: record.get('performedBy').filter(g => g.group !== null),
                        guests: record.get('guests').filter(g => g.guest !== null),
                        releases: record.get('releases').filter(r => r.release !== null)
                    }
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Track details failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/song/:songId
     * Get song details
     */
    router.get('/song/:songId', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (s:Song {song_id: $songId})
                    OPTIONAL MATCH (p:Person)-[:WROTE]->(s)
                    OPTIONAL MATCH (t:Track)-[:RECORDING_OF]->(s)
                    OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)

                    RETURN s,
                           collect(DISTINCT {
                               writer: p.name,
                               person_id: p.person_id
                           }) as writers,
                           collect(DISTINCT {
                               track: t.title,
                               track_id: t.track_id
                           }) as recordings,
                           collect(DISTINCT {
                               release: r.name,
                               release_id: r.release_id,
                               release_date: r.release_date,
                               album_art: r.album_art
                           }) as releases
                `, { songId: req.params.songId });

                if (result.records.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Song not found'
                    });
                }

                const record = result.records[0];
                const song = record.get('s').properties;

                res.json({
                    success: true,
                    data: {
                        ...song,
                        writers: record.get('writers').filter(w => w.writer !== null),
                        recordings: record.get('recordings').filter(r => r.track !== null),
                        releases: record.get('releases').filter(r => r.release !== null)
                    }
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Song details failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/label/:labelId
     * Get label details
     */
    router.get('/label/:labelId', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (l:Label {label_id: $labelId})
                    OPTIONAL MATCH (l)<-[:RELEASED]-(r:Release)

                    RETURN l,
                           collect(DISTINCT {
                               release: r.name,
                               release_id: r.release_id,
                               release_date: r.release_date
                           }) as releases,
                           count(r) as releaseCount
                `, { labelId: req.params.labelId });

                if (result.records.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Label not found'
                    });
                }

                const record = result.records[0];
                const label = record.get('l').properties;

                res.json({
                    success: true,
                    data: {
                        ...label,
                        releases: record.get('releases').filter(r => r.release !== null),
                        releaseCount: record.get('releaseCount').toNumber()
                    }
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Label details failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    /**
     * GET /api/groups/:groupId/details
     * Get comprehensive group information
     */
    router.get('/groups/:groupId/details', async (req, res) => {
        try {
            const session = db.driver.session();
            try {
                const result = await session.run(`
                    MATCH (g:Group {group_id: $groupId})
                    OPTIONAL MATCH (g)-[:PERFORMED_ON]->(t:Track)
                    OPTIONAL MATCH (t)-[:IN_RELEASE]->(r:Release)
                    OPTIONAL MATCH (p:Person)-[m:MEMBER_OF]->(g)

                    RETURN g,
                           count(DISTINCT t) as trackCount,
                           count(DISTINCT r) as releaseCount,
                           collect(DISTINCT {
                               person: p.name,
                               role: m.role,
                               from: m.from_date,
                               to: m.to_date
                           }) as members
                `, { groupId: req.params.groupId });

                if (result.records.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Group not found'
                    });
                }

                const record = result.records[0];
                const group = record.get('g').properties;

                res.json({
                    success: true,
                    group: {
                        ...group,
                        trackCount: record.get('trackCount').toNumber(),
                        releaseCount: record.get('releaseCount').toNumber(),
                        members: record.get('members')
                    }
                });
            } finally {
                await safeClose(session);
            }
        } catch (error) {
            console.error('Group details failed:', error);
            res.status(500).json(sanitizeError(error, req.requestId, { success: false, env: config.env }));
        }
    });

    return router;
}
