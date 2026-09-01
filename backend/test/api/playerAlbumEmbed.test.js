/**
 * Album embeds, so playback survives a track boundary.
 *
 * A Spotify track embed cannot advance: a plain iframe exposes nothing to call,
 * and loading Spotify's iFrame API would mean adding 'unsafe-eval' to the
 * page's CSP to gain a play button. An ALBUM embed carries Spotify's own queue
 * and continues on its own, which is the only route to continuous playback that
 * does not weaken the policy.
 *
 * Release nodes have carried listen_links since the submission form gained a
 * release-level field. Nothing exposed them, so the queue only ever saw
 * per-track links.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { PlayerService } from '../../src/api/playerService.js';

const service = new PlayerService({ session: () => ({ run: jest.fn(), close: jest.fn() }) });

const track = { track_id: 't1', title: 'In Bloom', listen_links: ['https://open.spotify.com/track/TRACK1'] };
const inRelease = { track_number: 2, disc_number: 1 };

/** @param {string[]|undefined} links */
const release = (links) => ({
    release_id: 'rel:1', name: 'Nevermind', release_date: '1991-09-24',
    ...(links ? { listen_links: links } : {}),
});

describe('release_embed_uri on queue entries', () => {
    test('an album link on the release is surfaced', () => {
        const entry = service._buildQueueEntry(
            track, inRelease, release(['https://open.spotify.com/album/ALBUM1']));

        expect(entry.release_embed_uri).toBe('spotify:album:ALBUM1');
    });

    test('the per-track link is still there as a fallback', () => {
        const entry = service._buildQueueEntry(
            track, inRelease, release(['https://open.spotify.com/album/ALBUM1']));

        // The frontend prefers the album but needs the track for releases that
        // have no album link.
        expect(entry.listen.embed_uri).toBe('spotify:track:TRACK1');
    });

    test('a release with no links yields null', () => {
        expect(service._buildQueueEntry(track, inRelease, release()).release_embed_uri)
            .toBeNull();
    });

    test('a release link that is a TRACK is not treated as an album', () => {
        // A single track gives no queue to advance through, and embedding it as
        // though it were the album would silently drop the rest of the record.
        const entry = service._buildQueueEntry(
            track, inRelease, release(['https://open.spotify.com/track/SINGLE']));

        expect(entry.release_embed_uri).toBeNull();
    });

    test('a non-Spotify release link yields null', () => {
        const entry = service._buildQueueEntry(
            track, inRelease, release(['https://music.apple.com/us/album/x/1']));

        expect(entry.release_embed_uri).toBeNull();
    });

    test('locale prefixes and share tokens are normalized away', () => {
        const entry = service._buildQueueEntry(track, inRelease,
            release(['https://open.spotify.com/intl-de/album/ALBUM1?si=abc']));

        expect(entry.release_embed_uri).toBe('spotify:album:ALBUM1');
    });

    test('the rest of the entry is unchanged', () => {
        const entry = service._buildQueueEntry(
            track, inRelease, release(['https://open.spotify.com/album/ALBUM1']));

        expect(entry).toMatchObject({
            track_id: 't1', track_name: 'In Bloom',
            track_number: 2, disc_number: 1,
            release_id: 'rel:1', release_name: 'Nevermind',
        });
    });
});
