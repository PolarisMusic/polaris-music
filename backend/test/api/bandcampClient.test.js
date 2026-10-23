/**
 * Reading a release off a Bandcamp page.
 *
 * Bandcamp has no catalogue API — their developer programme is an artist's own
 * sales and orders — so this reads the page, and the page is not a published
 * interface. Both structures it reads can change without notice, which is why
 * every field is optional, nothing throws on a missing one, and
 * scripts/checkBandcamp.js exists to show what a real page yields today.
 *
 * The fixtures below are built from the documented schema.org vocabulary and
 * from Bandcamp's long-standing player data. They were NOT taken from a live
 * page: this container cannot resolve bandcamp.com. So they prove the parser
 * handles the shapes it claims to handle, and the script proves the shapes are
 * still the right ones.
 */

import { describe, test, expect } from '@jest/globals';
import {
    BandcampClient, parseBandcampUrl, extractJsonLd, musicAlbumFrom, extractTralbum,
    decodeHtmlAttribute, durationSeconds, releaseDate, tagsFrom, albumFromPage,
} from '../../src/api/bandcampClient.js';

const JSON_LD = {
    '@type': 'MusicAlbum',
    name: 'The Ark (Vol.1)',
    byArtist: { '@type': 'MusicGroup', name: 'Various Artists' },
    publisher: { '@type': 'MusicGroup', name: 'Ark Records' },
    datePublished: '11 Nov 2014 00:00:00 GMT',
    creditText: 'Recorded at Lost Ark Studio.\nDrums on track 3 by Andrew Ware.',
    description: 'A charity compilation.',
    keywords: 'post-rock, shoegaze, Portland',
    image: 'https://f4.bcbits.com/img/a1234_10.jpg',
    track: {
        '@type': 'ItemList',
        itemListElement: [
            { '@type': 'ListItem', position: 1,
                item: { '@type': 'MusicRecording', name: 'Turns To Dust',
                    duration: 'P00H03M17S', '@id': 'https://ark.bandcamp.com/track/turns-to-dust' } },
            { '@type': 'ListItem', position: 2,
                item: { '@type': 'MusicRecording', name: 'Out To Sea',
                    duration: 'P00H04M08S', '@id': 'https://ark.bandcamp.com/track/out-to-sea' } },
        ],
    },
};

const TRALBUM = {
    artist: 'Various Artists',
    current: { title: 'The Ark (Vol.1)', release_date: '11 Nov 2014 00:00:00 GMT',
        credits: 'Recorded at Lost Ark Studio.', about: 'A charity compilation.' },
    trackinfo: [
        { title: 'Turns To Dust', track_num: 1, duration: 197.333, title_link: '/track/turns-to-dust' },
        { title: 'Out To Sea', track_num: 2, duration: 248.52, title_link: '/track/out-to-sea' },
    ],
};

/** A page carrying both structures, the way Bandcamp serves one. */
const pageWith = ({ jsonLd = JSON_LD, tralbum = TRALBUM } = {}) => {
    const attribute = tralbum
        ? ` data-tralbum="${JSON.stringify(tralbum).replace(/"/g, '&quot;')}"`
        : '';
    const block = jsonLd
        ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
        : '';
    return `<!doctype html><html><head>
        <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
        ${block}</head><body><div id="pagedata"${attribute}></div></body></html>`;
};

const URL_UNDER_TEST = 'https://ark.bandcamp.com/album/the-ark-vol-1';

describe('which URLs are release pages', () => {
    test.each([
        ['an album', 'https://ark.bandcamp.com/album/the-ark-vol-1', 'album'],
        ['a track', 'https://ark.bandcamp.com/track/solstice', 'track'],
    ])('%s is one', (_label, url, kind) => {
        expect(parseBandcampUrl(url)).toEqual({ url, kind });
    });

    test('tracking parameters are not identity', () => {
        expect(parseBandcampUrl(
            'https://ark.bandcamp.com/album/the-ark-vol-1?from=hp&utm_source=x#t2').url)
            .toBe('https://ark.bandcamp.com/album/the-ark-vol-1');
    });

    test.each([
        ['a discography page', 'https://ark.bandcamp.com/music'],
        ['the front page', 'https://bandcamp.com/'],
        ['a lookalike host', 'https://bandcamp.com.evil.test/album/x'],
        ['another site', 'https://example.com/album/x'],
        ['plain text', 'the ark vol 1'],
    ])('%s is not', (_label, url) => {
        expect(parseBandcampUrl(url)).toBeNull();
    });

    test('a label on its own domain is not fetched, because nothing says it is one', () => {
        // Bandcamp lets a label point its own domain at a store, and from the
        // URL alone that is indistinguishable from any other website. Guessing
        // wrong means fetching a stranger's site on a submitter's behalf.
        expect(parseBandcampUrl('https://arkrecords.com/album/the-ark-vol-1')).toBeNull();
    });
});

describe('finding the structured data', () => {
    test('the album block is picked out from among the others', () => {
        const blocks = extractJsonLd(pageWith());

        expect(blocks).toHaveLength(2);
        expect(musicAlbumFrom(blocks).name).toBe('The Ark (Vol.1)');
    });

    test('a @graph wrapper is unwrapped', () => {
        const html = `<script type="application/ld+json">${JSON.stringify(
            { '@graph': [{ '@type': 'Organization' }, JSON_LD] })}</script>`;

        expect(musicAlbumFrom(extractJsonLd(html)).name).toBe('The Ark (Vol.1)');
    });

    test('a malformed block does not take the page down with it', () => {
        const html = '<script type="application/ld+json">{ not json </script>'
            + `<script type="application/ld+json">${JSON.stringify(JSON_LD)}</script>`;

        expect(musicAlbumFrom(extractJsonLd(html))).not.toBeNull();
    });

    test('the player data is read through its attribute escaping', () => {
        expect(extractTralbum(pageWith()).trackinfo).toHaveLength(2);
    });

    test('and from the older script assignment', () => {
        const html = `<script>var TralbumData = ${JSON.stringify(TRALBUM)};</script>`;
        expect(extractTralbum(html).artist).toBe('Various Artists');
    });

    test('a page with neither yields nothing rather than an empty release', () => {
        expect(albumFromPage('<html><body>Hello</body></html>', URL_UNDER_TEST)).toBeNull();
    });
});

describe('the release it reads', () => {
    test('name, act, label and date', () => {
        const album = albumFromPage(pageWith(), URL_UNDER_TEST);

        expect(album).toMatchObject({
            name: 'The Ark (Vol.1)',
            artist: 'Various Artists',
            label: 'Ark Records',
            release_date: '2014/11/11',
            url: URL_UNDER_TEST,
        });
    });

    test('the tracklist, with the player data winning on duration', () => {
        // JSON-LD rounds to the second; the player data has the real figure.
        const album = albumFromPage(pageWith(), URL_UNDER_TEST);

        expect(album.tracks).toEqual([
            { title: 'Turns To Dust', position: 1, duration: 197,
                url: 'https://ark.bandcamp.com/track/turns-to-dust' },
            { title: 'Out To Sea', position: 2, duration: 249,
                url: 'https://ark.bandcamp.com/track/out-to-sea' },
        ]);
    });

    test('JSON-LD alone is enough', () => {
        const album = albumFromPage(pageWith({ tralbum: null }), URL_UNDER_TEST);

        expect(album.tracks.map((t) => t.duration)).toEqual([197, 248]);
        expect(album.name).toBe('The Ark (Vol.1)');
    });

    test('and so is the player data alone', () => {
        // Which is the case that matters if they ever drop the JSON-LD.
        const album = albumFromPage(pageWith({ jsonLd: null }), URL_UNDER_TEST);

        expect(album.name).toBe('The Ark (Vol.1)');
        expect(album.tracks.map((t) => t.title)).toEqual(['Turns To Dust', 'Out To Sea']);
        expect(album.tracks[0].url).toBe('https://ark.bandcamp.com/track/turns-to-dust');
    });

    test('the credits come through as the free text they are', () => {
        // Bandcamp has no structured credits at all: no roles, no per-person
        // fields, nothing a parser can trust. It is liner notes.
        const album = albumFromPage(pageWith(), URL_UNDER_TEST);

        expect(album.credits).toContain('Drums on track 3 by Andrew Ware');
        expect(album.about).toBe('A charity compilation.');
    });

    test('the tags are the artist’s own genre statement', () => {
        expect(albumFromPage(pageWith(), URL_UNDER_TEST).tags)
            .toEqual(['post-rock', 'shoegaze', 'Portland']);
    });

    test('a release with none of the optional fields still reads', () => {
        const album = albumFromPage(pageWith({
            jsonLd: { '@type': 'MusicAlbum', name: 'Demo' }, tralbum: null,
        }), URL_UNDER_TEST);

        expect(album).toMatchObject({
            name: 'Demo', artist: null, label: null, release_date: '', credits: null,
        });
        expect(album.tracks).toEqual([]);
        expect(album.tags).toEqual([]);
    });

    test('a nameless release is not a release', () => {
        expect(albumFromPage(pageWith({
            jsonLd: { '@type': 'MusicAlbum' }, tralbum: { trackinfo: [] },
        }), URL_UNDER_TEST)).toBeNull();
    });

    test('a track with no title is skipped rather than carried blank', () => {
        const album = albumFromPage(pageWith({
            tralbum: { ...TRALBUM, trackinfo: [{ title: '', duration: 10 },
                { title: 'Real', track_num: 2, duration: 20 }] },
            jsonLd: { ...JSON_LD, track: undefined },
        }), URL_UNDER_TEST);

        expect(album.tracks.map((t) => t.title)).toEqual(['Real']);
    });
});

describe('durations, however the page spells them', () => {
    test.each([
        ["Bandcamp's own ISO variant", 'P00H03M17S', 197],
        ['a real ISO duration', 'PT3M17S', 197],
        ['under a minute', 'P00H00M45S', 45],
        ['over an hour', 'P01H02M03S', 3723],
        ['the player data float', 197.333, 197],
    ])('%s', (_label, value, expected) => {
        expect(durationSeconds(value)).toBe(expected);
    });

    test.each([
        ['a display string', '3:17'],
        ['nothing', null],
        ['zero', 0],
        ['nonsense', 'soon'],
    ])('%s is null rather than a guess', (_label, value) => {
        // A wrong duration is a claim about the recording.
        expect(durationSeconds(value)).toBeNull();
    });
});

describe('fetching one', () => {
    const okResponse = (html) => ({ ok: true, status: 200, text: async () => html });

    test('it asks for the canonical page and says who is asking', async () => {
        const asked = [];
        const client = new BandcampClient({
            fetchImpl: async (url, options) => {
                asked.push({ url, headers: options?.headers });
                return okResponse(pageWith());
            },
        });

        const album = await client.fetchRelease(
            'https://ark.bandcamp.com/album/the-ark-vol-1?from=hp');

        expect(asked[0].url).toBe(URL_UNDER_TEST);
        expect(asked[0].headers['User-Agent']).toMatch(/PolarisMusicRegistry.*polaris\.mu/);
        expect(album.name).toBe('The Ark (Vol.1)');
    });

    test('a URL that is not a release page is refused before any request', async () => {
        const fetchImpl = async () => { throw new Error('should not be called'); };
        const client = new BandcampClient({ fetchImpl });

        await expect(client.fetchRelease('https://example.com/album/x'))
            .rejects.toMatchObject({ reason: 'not_bandcamp' });
    });

    test('an HTTP failure carries its status', async () => {
        const client = new BandcampClient({
            fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
        });

        await expect(client.fetchRelease(URL_UNDER_TEST))
            .rejects.toMatchObject({ status: 404 });
    });

    test('a page it cannot read is null, not an error', async () => {
        // Bandcamp changing their markup is not this server failing, and the
        // caller says so differently.
        const client = new BandcampClient({
            fetchImpl: async () => okResponse('<html><body>nothing here</body></html>'),
        });

        expect(await client.fetchRelease(URL_UNDER_TEST)).toBeNull();
    });

    test('it needs no credentials, unlike every other source here', () => {
        expect(new BandcampClient().isConfigured()).toBe(true);
    });
});

describe('attribute escaping', () => {
    test.each([
        ['quotes', '{&quot;a&quot;:1}', '{"a":1}'],
        ['ampersands', 'Simon &amp; Garfunkel', 'Simon & Garfunkel'],
        ['apostrophes', 'Don&#39;t', "Don't"],
        ['hex escapes', '&#x27;', "'"],
        ['angle brackets', '&lt;b&gt;', '<b>'],
    ])('%s', (_label, input, expected) => {
        expect(decodeHtmlAttribute(input)).toBe(expected);
    });

    test('an escaped ampersand does not decode twice', () => {
        // &amp;quot; is a literal &quot; in the text, not a quote.
        expect(decodeHtmlAttribute('&amp;quot;')).toBe('&quot;');
    });
});

describe('tags', () => {
    test('a comma string and an array read the same', () => {
        expect(tagsFrom({ keywords: 'a, b' })).toEqual(['a', 'b']);
        expect(tagsFrom({ keywords: ['a', 'b'] })).toEqual(['a', 'b']);
    });

    test('duplicates collapse, case-insensitively, keeping the first spelling', () => {
        expect(tagsFrom({ keywords: 'Post-Rock, post-rock' })).toEqual(['Post-Rock']);
    });

    test('no keywords is no tags', () => {
        expect(tagsFrom({})).toEqual([]);
        expect(tagsFrom(null)).toEqual([]);
    });
});

describe('dates', () => {
    test.each([
        ["Bandcamp's own format", '11 Nov 2014 00:00:00 GMT', '2014/11/11'],
        ['an ISO date', '2014-11-11', '2014/11/11'],
        ['an ISO timestamp', '2014-11-11T00:00:00Z', '2014/11/11'],
    ])('%s', (_label, value, expected) => {
        expect(releaseDate(value)).toBe(expected);
    });

    test('a midnight GMT release does not slip to the day before', () => {
        // Read in the server's zone it would, and the registry would carry a
        // release date nobody published.
        expect(releaseDate('11 Nov 2014 00:00:00 GMT')).toBe('2014/11/11');
    });

    test('nothing usable is empty, not Invalid Date', () => {
        expect(releaseDate('')).toBe('');
        expect(releaseDate('soon')).toBe('');
        expect(releaseDate(null)).toBe('');
    });
});
