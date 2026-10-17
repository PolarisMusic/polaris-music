#!/usr/bin/env node
/**
 * @fileoverview Find out why the Spotify check is unavailable.
 *
 * The endpoint has four distinct ways to be "unavailable" — credentials not
 * set, credentials rejected, the app refused for an endpoint, or no outbound
 * access to Spotify at all — and before the failure classification in
 * routes/spotify.js they all reached the submission form as one sentence.
 * That happened on polaris.mu on 2026-10-17 and answering it meant reading
 * container logs.
 *
 * This asks each question directly, in the order the client asks them, and
 * names the fix for whichever one fails. It runs *inside the API container*,
 * so it sees exactly the environment and the network the server sees:
 *
 *   docker compose exec api node scripts/checkSpotify.js
 *   docker compose exec api node scripts/checkSpotify.js 4Ue5ns8UWd24iX5t4V8ssr
 *
 * NOTHING SECRET IS PRINTED. The credentials are reported as lengths and a
 * fingerprint of the last four characters, which is enough to tell "the wrong
 * value is set" from "no value is set" without putting a secret in a terminal
 * that may be logged or shared.
 *
 * Exit code is 0 when every step passed, 1 otherwise, so it can gate a deploy.
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

/** A well-known album, used when none is given: Blue Öyster Cult, Fire of Unknown Origin. */
const DEFAULT_ALBUM = process.argv[2] || '4Ue5ns8UWd24iX5t4V8ssr';

const tick = (ok) => (ok ? '✓' : '✗');

/**
 * Describe a secret without disclosing it.
 *
 * @param {string} value
 * @returns {string}
 */
function fingerprint(value) {
    if (!value) return 'not set';
    if (value.length <= 4) return `${value.length} chars (suspiciously short)`;
    return `${value.length} chars, ending …${value.slice(-4)}`;
}

async function main() {
    const id = process.env.SPOTIFY_CLIENT_ID ?? '';
    const secret = process.env.SPOTIFY_CLIENT_SECRET ?? '';

    console.log('1. Credentials in this process');
    console.log(`   SPOTIFY_CLIENT_ID:     ${fingerprint(id)}`);
    console.log(`   SPOTIFY_CLIENT_SECRET: ${fingerprint(secret)}`);

    if (!id || !secret) {
        console.log(`\n${tick(false)} Not configured. The endpoint reports itself unconfigured`);
        console.log('  and the form says the check is unavailable — which is correct, not a');
        console.log('  fault. Set both in the environment the API container reads (.env at the');
        console.log('  compose root; docker-compose.yml passes them through), then recreate it:');
        console.log('      docker compose up -d api');
        return 1;
    }

    console.log('\n2. Token exchange (client credentials)');
    let token;
    try {
        const basic = Buffer.from(`${id}:${secret}`).toString('base64');
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });

        console.log(`   HTTP ${response.status} ${tick(response.ok)}`);
        if (!response.ok) {
            // The body can echo the credentials back in an error_description,
            // so only the machine-readable code is printed.
            const body = await response.json().catch(() => ({}));
            console.log(`   error: ${body.error ?? '(no code)'}`);
            console.log('\n  Spotify rejected these credentials. They are present but wrong,');
            console.log('  revoked, or from a different app. Re-copy both from');
            console.log('  https://developer.spotify.com/dashboard → your app → Settings.');
            return 1;
        }
        token = (await response.json()).access_token;
    } catch (error) {
        console.log(`   ${tick(false)} ${error.name}: ${error.message}`);
        console.log('\n  This container could not reach accounts.spotify.com at all. That is');
        console.log('  egress, not credentials: check the container’s DNS and whether');
        console.log('  outbound 443 is permitted from the api service.');
        return 1;
    }

    console.log('\n3. Album lookup (what the form asks for first)');
    const album = await probe(`/albums/${DEFAULT_ALBUM}`, token);
    if (!album.ok) return 1;
    console.log(`   "${album.body.name}" — ${album.body.total_tracks} tracks, `
        + `UPC ${album.body.external_ids?.upc ?? '(none)'}`);

    const trackIds = (album.body.tracks?.items ?? []).map(t => t.id).filter(Boolean).slice(0, 50);

    console.log('\n4. Full tracks (the ISRCs; a separate endpoint)');
    if (trackIds.length === 0) {
        console.log('   skipped: the album returned no track ids');
    } else {
        const tracks = await probe(`/tracks?ids=${trackIds.join(',')}`, token);
        if (!tracks.ok) {
            console.log('\n  The tracklist comparison still works without this — the client');
            console.log('  degrades to no ISRCs — but cross-service links need it.');
            return 1;
        }
        const withIsrc = (tracks.body.tracks ?? []).filter(t => t?.external_ids?.isrc).length;
        console.log(`   ${withIsrc} of ${trackIds.length} tracks carry an ISRC`);
    }

    console.log('\n5. Barcode search (the Discogs import path)');
    const upc = album.body.external_ids?.upc;
    if (!upc) {
        console.log('   skipped: that album carries no UPC to search for');
    } else {
        const search = await probe(
            `/search?q=${encodeURIComponent(`upc:${upc}`)}&type=album&limit=3`, token);
        if (!search.ok) {
            console.log('\n  /search is the one endpoint an app in development mode can be');
            console.log('  refused for. Album links still work; only the barcode shortcut');
            console.log('  does not. Request extended quota, or paste album links by hand.');
            return 1;
        }
        const hits = search.body.albums?.items ?? [];
        console.log(`   ${hits.length} album(s) under that barcode`);
    }

    console.log('\n✓ Every step passed. If the form still says the check is unavailable,');
    console.log('  the failure is downstream of Spotify — read the api log for the line');
    console.log('  beginning "Spotify lookup".');
    return 0;
}

/**
 * One GET against the API, reported in the same shape for every step.
 *
 * @param {string} path
 * @param {string} token
 * @returns {Promise<{ok: boolean, body: Object}>}
 */
async function probe(path, token) {
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`   HTTP ${response.status} ${tick(response.ok)}  GET ${path.slice(0, 60)}`);

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.log(`   message: ${body.error?.message ?? '(none)'}`);
        }
        return { ok: response.ok, body };
    } catch (error) {
        console.log(`   ${tick(false)} ${error.name}: ${error.message}  GET ${path.slice(0, 60)}`);
        return { ok: false, body: {} };
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('check failed:', error);
        process.exit(1);
    });
