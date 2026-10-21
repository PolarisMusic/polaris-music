#!/usr/bin/env node
/**
 * @fileoverview Import genre tags from MusicBrainz for releases and their bands.
 *
 * Reads a barcode off each Release, finds the MusicBrainz release filed under
 * it, and takes the genres and tags from that release's release-group and
 * artist. Nothing is matched by name and nothing is anchored on chain — see
 * api/genreImport.js for why both of those are deliberate.
 *
 * Usage:
 *
 *   # Report only. Reads MusicBrainz, writes nothing.
 *   docker compose exec api node scripts/importGenres.js
 *
 *   # Apply, for the first 50 untagged releases.
 *   docker compose exec api node scripts/importGenres.js --execute
 *
 *   # More of them, or re-ask about ones already imported.
 *   docker compose exec api node scripts/importGenres.js --execute --limit 200
 *   docker compose exec api node scripts/importGenres.js --execute --refresh
 *
 * MusicBrainz permits one request per second and the client holds to it, so a
 * run costs roughly two seconds a release — a minute for 30, half an hour for
 * 900. That is why --limit defaults to 50 and why the count is printed before
 * the work starts.
 *
 * Environment: GRAPH_URI, GRAPH_USER, GRAPH_PASSWORD, and optionally
 * MUSICBRAINZ_USER_AGENT. Inside the api container it needs none of them on the
 * command line.
 */

import MusicGraphDatabase from '../src/graph/schema.js';
import { MusicBrainzClient } from '../src/api/musicbrainzClient.js';
import { GenreImporter } from '../src/api/genreImport.js';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const refresh = args.includes('--refresh');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) || 50 : 50;

/** How an outcome reads in the report. */
const OUTCOMES = {
    imported: '+',
    not_on_musicbrainz: '-',
    ambiguous_release_group: '?',
    lookup_failed: '!',
};

async function main() {
    const graph = new MusicGraphDatabase({
        // 127.0.0.1, never localhost: the runbook documents an SSH tunnel on
        // 7687, ssh binds it on ::1, Docker publishes on 127.0.0.1, and since
        // Node 17 dns.lookup no longer prefers IPv4 — so `localhost` can reach
        // the tunnel and a laptop would write to production.
        uri: process.env.GRAPH_URI || 'bolt://127.0.0.1:7687',
        user: process.env.GRAPH_USER || 'neo4j',
        password: process.env.GRAPH_PASSWORD || 'polarisdev',
    });
    const musicbrainz = new MusicBrainzClient();
    const importer = new GenreImporter({ graph, musicbrainz });

    try {
        console.log(execute ? 'Importing' : 'Reporting only (no writes)');
        console.log(`Up to ${limit} release(s)${refresh ? ', including already imported' : ''}`);
        console.log('MusicBrainz allows one request a second, so this takes a while.\n');

        const { considered, results } = await importer.run({ limit, refresh, execute });

        for (const result of results) {
            console.log(`  ${OUTCOMES[result.outcome] ?? ' '}  ${result.name ?? result.id}`);
            console.log(`       barcode ${result.barcode} — ${result.outcome.replace(/_/g, ' ')}`);

            for (const [what, detail] of Object.entries(result.tagged ?? {})) {
                if (!detail) continue;
                if (detail.error) {
                    console.log(`       ${what}: ${detail.error}`);
                    continue;
                }
                const genres = detail.genres.length ? detail.genres.join(', ') : '(none)';
                const tags = detail.tags.length ? detail.tags.join(', ') : '(none)';
                console.log(`       ${what} genres: ${genres}`);
                console.log(`       ${what} tags:   ${tags}`);
            }
        }

        const counts = results.reduce((acc, r) => {
            acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
            return acc;
        }, {});

        console.log(`\n${considered} release(s) considered`);
        for (const [outcome, count] of Object.entries(counts)) {
            console.log(`  ${outcome.replace(/_/g, ' ')}: ${count}`);
        }

        if (considered === 0) {
            console.log('\nNothing to do. Either every release with a barcode is already');
            console.log('tagged (try --refresh), or no release carries one yet — the');
            console.log('barcode arrives with a Discogs import, so older releases have none.');
        }
        if (!execute && considered > 0) {
            console.log('\nReport only — nothing was written. Re-run with --execute to apply.');
        }
        return 0;
    } finally {
        await graph.close?.();
    }
}

// Only when run, not when imported.
if (process.argv[1] && process.argv[1].endsWith('importGenres.js')) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error('import failed:', error.message);
            process.exit(1);
        });
}
