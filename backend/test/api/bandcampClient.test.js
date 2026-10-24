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
    labelFrom, trackUrl, formatFrom, otherEditions,
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
    item_type: 'album',
    hasAudio: true,
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
            { title: 'Turns To Dust', position: 1, duration: 197, artist: null,
                url: 'https://ark.bandcamp.com/track/turns-to-dust' },
            { title: 'Out To Sea', position: 2, duration: 249, artist: null,
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

/**
 * A live page, read on 2026-10-24: howlinrain.bandcamp.com's "Watermelon", a
 * preorder that Silver Current Records put out on the band's own Bandcamp
 * page. Trimmed to the fields the importer reads, and to four tracks of nine
 * — two with pages of their own, two listed only as album-page fragments,
 * which is the mix a preorder serves.
 *
 * Unlike the fixtures above, this one was taken from a real page, and it is
 * here because running scripts/checkBandcamp.js against it found two bugs the
 * invented fixtures could not: the label read as the band, and six of nine
 * tracks got the album page as their "track" link.
 */
const LIVE_JSON_LD = {
    '@type': 'MusicAlbum',
    '@id': 'https://howlinrain.bandcamp.com/album/watermelon',
    name: 'Watermelon',
    byArtist: { '@type': 'MusicGroup', name: 'Howlin Rain' },
    // The page's own band, which is the act here — not the label.
    publisher: {
        '@type': 'MusicGroup',
        name: 'Howlin Rain',
        foundingLocation: { '@type': 'Place', name: 'Oakland, California' },
    },
    datePublished: '13 Nov 2026 00:00:00 GMT',
    numTracks: 9,
    albumRelease: [
        {
            '@type': ['MusicRelease', 'Product'],
            name: 'Watermelon',
            musicReleaseFormat: 'DigitalFormat',
            recordLabel: {
                '@type': 'MusicGroup',
                name: 'Silver Current Records',
                '@id': 'https://silvercurrent.bandcamp.com',
            },
        },
        { '@type': ['MusicRelease', 'Product'], name: 'Classic Black Vinyl', musicReleaseFormat: 'VinylFormat' },
        { '@type': ['MusicRelease', 'Product'], name: 'Compact Disc', musicReleaseFormat: 'CDFormat' },
    ],
    track: {
        '@type': 'ItemList',
        numberOfItems: 9,
        itemListElement: [
            { '@type': 'ListItem', position: 1,
                item: { '@type': 'MusicRecording',
                    '@id': 'https://howlinrain.bandcamp.com/track/silver-paper-with-chris-robinson',
                    name: 'Silver Paper (with Chris Robinson)',
                    duration: 'P00H04M57S',
                    mainEntityOfPage: 'https://howlinrain.bandcamp.com/track/silver-paper-with-chris-robinson' } },
            // No page of its own: the id is the album plus a fragment, and
            // there is no duration because the track is not streaming yet.
            { '@type': 'ListItem', position: 2,
                item: { '@type': 'MusicRecording',
                    '@id': 'https://howlinrain.bandcamp.com/album/watermelon#t2',
                    name: 'Jesus Was A Cross Maker' } },
            { '@type': 'ListItem', position: 3,
                item: { '@type': 'MusicRecording',
                    '@id': 'https://howlinrain.bandcamp.com/track/fall-away',
                    name: 'Fall Away',
                    duration: 'P00H03M29S',
                    mainEntityOfPage: 'https://howlinrain.bandcamp.com/track/fall-away' } },
            { '@type': 'ListItem', position: 4,
                item: { '@type': 'MusicRecording',
                    '@id': 'https://howlinrain.bandcamp.com/album/watermelon#t4',
                    name: 'I Am Not Willing' } },
        ],
    },
};

const LIVE_TRALBUM = {
    artist: 'Howlin Rain',
    item_type: 'album',
    hasAudio: true,
    is_preorder: true,
    current: {
        title: 'Watermelon',
        type: 'album',
        release_date: '13 Nov 2026 00:00:00 GMT',
        band_id: 3614686597,
        selling_band_id: 545422245,
        upc: null,
        credits: 'The Players:\nEthan Miller: vocals, electric and acoustic guitar',
        about: 'In celebration of 20 years riding the bus to never-ever land.',
    },
    packages: [
        { type_name: 'Vinyl LP', title: 'Colored Vinyl Bandcamp Edition', label: 'Silver Current Records' },
        { type_name: 'Vinyl LP', title: 'Classic Black Vinyl', label: 'Silver Current Records' },
        { type_name: 'Compact Disc (CD)', title: 'Compact Disc', label: 'Silver Current Records' },
    ],
    trackinfo: [
        { track_num: 1, title: 'Silver Paper (with Chris Robinson)', duration: 297.427,
            title_link: '/track/silver-paper-with-chris-robinson', unreleased_track: false },
        { track_num: 2, title: 'Jesus Was A Cross Maker', duration: 0,
            title_link: null, unreleased_track: true },
        { track_num: 3, title: 'Fall Away', duration: 209.52,
            title_link: '/track/fall-away', unreleased_track: false },
        { track_num: 4, title: 'I Am Not Willing', duration: 0,
            title_link: null, unreleased_track: true },
    ],
};

const LIVE_URL = 'https://howlinrain.bandcamp.com/album/watermelon';
const livePage = (overrides = {}) => pageWith({
    jsonLd: { ...LIVE_JSON_LD, ...overrides.jsonLd },
    tralbum: overrides.tralbum === null ? null : { ...LIVE_TRALBUM, ...overrides.tralbum },
});

describe('the label, which is not whoever publishes the page', () => {
    test('the label is the one the release states, not the band whose page it is', () => {
        // The bug this replaces read `publisher`, which on an act's own page
        // is the act: it would have minted a Label node called "Howlin Rain"
        // for a record Silver Current Records released.
        expect(albumFromPage(livePage(), LIVE_URL).label).toBe('Silver Current Records');
    });

    test('the player data states it too, for when the JSON-LD stops', () => {
        const album = albumFromPage(livePage({
            jsonLd: { albumRelease: [{ musicReleaseFormat: 'DigitalFormat' }] },
        }), LIVE_URL);

        expect(album.label).toBe('Silver Current Records');
    });

    test('a self-released record has no label, not one named after the band', () => {
        const album = albumFromPage(livePage({
            jsonLd: { albumRelease: [{ musicReleaseFormat: 'DigitalFormat' }] },
            tralbum: { packages: [] },
        }), LIVE_URL);

        expect(album.artist).toBe('Howlin Rain');
        expect(album.label).toBeNull();
    });

    test('an album on a label’s own page takes the label from the publisher', () => {
        // The one case where the page's publisher IS the label: the page
        // belongs to the label and the act is someone else.
        expect(albumFromPage(pageWith(), URL_UNDER_TEST).label).toBe('Ark Records');
    });

    test.each([
        ['the same name', 'Howlin Rain', 'Howlin Rain'],
        ['the same name cased differently', 'HOWLIN RAIN', 'Howlin Rain'],
        ['the same name padded', '  Howlin Rain  ', 'Howlin Rain'],
    ])('a publisher that is %s as the act is not a label', (_label, publisher, act) => {
        expect(labelFrom({ publisher: { name: publisher } }, null, act)).toBeNull();
    });

    test('a stated label wins over a publisher that differs from the act', () => {
        expect(labelFrom(
            { publisher: { name: 'Some Store' }, albumRelease: [{ recordLabel: { name: 'Real Label' } }] },
            null, 'The Band',
        )).toBe('Real Label');
    });
});

describe('a track page, which not every track on an album has', () => {
    test('a track with a page of its own is linked to it', () => {
        const album = albumFromPage(livePage(), LIVE_URL);

        expect(album.tracks[0].url)
            .toBe('https://howlinrain.bandcamp.com/track/silver-paper-with-chris-robinson');
        expect(album.tracks[2].url).toBe('https://howlinrain.bandcamp.com/track/fall-away');
    });

    test('a track listed only as an album-page fragment gets no link at all', () => {
        // Not the album page: that is where six of this album's nine tracks
        // used to point, which is worse than no link.
        const album = albumFromPage(livePage(), LIVE_URL);

        expect(album.tracks[1].url).toBeNull();
        expect(album.tracks[3].url).toBeNull();
    });

    test('no track link is ever an address with a fragment', () => {
        const links = albumFromPage(livePage(), LIVE_URL).tracks.map((t) => t.url);

        expect(links.filter((link) => link?.includes('#'))).toEqual([]);
    });

    test('the player’s relative link resolves against the album', () => {
        expect(trackUrl({}, { title_link: '/track/fall-away' }, LIVE_URL))
            .toBe('https://howlinrain.bandcamp.com/track/fall-away');
    });

    test('a fragment in mainEntityOfPage is refused as well', () => {
        expect(trackUrl({ mainEntityOfPage: `${LIVE_URL}#t7` }, {}, LIVE_URL)).toBeNull();
    });

    test('an id with no fragment is taken when nothing else is offered', () => {
        expect(trackUrl({ '@id': 'https://x.bandcamp.com/track/y' }, {}, LIVE_URL))
            .toBe('https://x.bandcamp.com/track/y');
    });

    test('an unresolvable player link is null, not a throw', () => {
        expect(trackUrl({}, { title_link: 'http://[' }, LIVE_URL)).toBeNull();
    });
});

describe('the format, which is the release this page is', () => {
    test('an album page is its digital release, whatever else it sells', () => {
        // The physical editions are separate Releases: format is part of the
        // release fingerprint, so folding a CD in here would merge it onto
        // the LP.
        expect(albumFromPage(livePage(), LIVE_URL).format).toBe('Digital');
    });

    test('a track page is a single', () => {
        expect(formatFrom({ '@type': 'MusicAlbum' }, { item_type: 'track' })).toBe('Single');
    });

    test.each([
        ['vinyl only', 'VinylFormat', 'LP'],
        ['CD only', 'CDFormat', 'CD'],
        ['cassette only', 'CassetteFormat', 'Cassette'],
        ['a format with no name here', 'HoloTapeFormat', 'Other'],
    ])('%s takes that format', (_label, releaseFormat, expected) => {
        expect(formatFrom({ albumRelease: [{ musicReleaseFormat: releaseFormat }] }, {}))
            .toBe(expected);
    });

    test('a page that states no format but has audio is digital', () => {
        expect(formatFrom(null, { item_type: 'album', hasAudio: true })).toBe('Digital');
    });

    test('a page that states nothing at all gets no format, not a guess', () => {
        expect(formatFrom(null, null)).toBeNull();
    });
});

describe('the editions sold beside the digital release', () => {
    test('they are reported under Bandcamp’s own names, deduplicated', () => {
        // Three vinyl packages, one Vinyl LP: a submitter needs to know the
        // editions exist, not how many variants of each are on sale.
        expect(albumFromPage(livePage(), LIVE_URL).other_editions)
            .toEqual(['Vinyl LP', 'Compact Disc (CD)']);
    });

    test('a digital-only release has none', () => {
        expect(otherEditions({ packages: [] })).toEqual([]);
        expect(otherEditions(null)).toEqual([]);
    });
});

describe('a preorder, where most of the record is not streaming yet', () => {
    test('a track with no audio has no duration, rather than a zero', () => {
        const durations = albumFromPage(livePage(), LIVE_URL).tracks.map((t) => t.duration);

        expect(durations).toEqual([297, null, 210, null]);
    });

    test('the tracklist is still complete, audio or not', () => {
        expect(albumFromPage(livePage(), LIVE_URL).tracks.map((t) => t.title)).toEqual([
            'Silver Paper (with Chris Robinson)',
            'Jesus Was A Cross Maker',
            'Fall Away',
            'I Am Not Willing',
        ]);
    });

    test('a release date in the future is read as given', () => {
        expect(albumFromPage(livePage(), LIVE_URL).release_date).toBe('2026/11/13');
    });
});

describe('the UPC, which a credits lookup needs and Bandcamp seldom has', () => {
    test('null when the page carries none', () => {
        expect(albumFromPage(livePage(), LIVE_URL).upc).toBeNull();
    });

    test('passed through when it does', () => {
        expect(albumFromPage(livePage({ tralbum: { current: { ...LIVE_TRALBUM.current, upc: '123456789012' } } }),
            LIVE_URL).upc).toBe('123456789012');
    });
});

describe('the act credited on a track, which only a compilation states', () => {
    test('a single-act record leaves it null and the release act stands', () => {
        // Both fields are null on a band's own album: the tracks are theirs.
        const album = albumFromPage(livePage(), LIVE_URL);

        expect(album.artist).toBe('Howlin Rain');
        expect(album.tracks.map((t) => t.artist)).toEqual([null, null, null, null]);
    });

    test('the JSON-LD states it on a compilation', () => {
        const album = albumFromPage(livePage({
            jsonLd: { track: { itemListElement: [
                { position: 1, item: { name: 'Turns To Dust', byArtist: { name: 'Ides' } } },
                { position: 2, item: { name: 'Out To Sea', byArtist: { name: 'Hollow Sun' } } },
            ] } },
            tralbum: { trackinfo: [] },
        }), LIVE_URL);

        expect(album.tracks.map((t) => t.artist)).toEqual(['Ides', 'Hollow Sun']);
    });

    test('the player data states it too', () => {
        const album = albumFromPage(livePage({
            jsonLd: { track: { itemListElement: [] } },
            tralbum: { trackinfo: [
                { track_num: 1, title: 'Turns To Dust', artist: 'Ides', duration: 197 },
            ] },
        }), LIVE_URL);

        expect(album.tracks[0].artist).toBe('Ides');
    });

    test('the JSON-LD wins where both speak, as everywhere else', () => {
        const album = albumFromPage(livePage({
            jsonLd: { track: { itemListElement: [
                { position: 1, item: { name: 'Turns To Dust', byArtist: { name: 'Ides' } } },
            ] } },
            tralbum: { trackinfo: [{ track_num: 1, title: 'Turns To Dust', artist: 'Someone Else' }] },
        }), LIVE_URL);

        expect(album.tracks[0].artist).toBe('Ides');
    });
});
