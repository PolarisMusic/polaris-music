/**
 * Links to a particular thing in the graph.
 *
 * The registry is one page that opens on whatever the lottery drew, so there
 * was no way to say "look at this one". A share link names the node — and
 * where the node only makes sense in a context, names that too: a guest chip
 * exists in the orbit of one release, and is only drawn at all when a toggle
 * is on. A link that dropped either would open somewhere adjacent to what the
 * sender was looking at, which is worse than not sharing.
 *
 * Lives under backend/test for the usual reason: the frontend has no
 * unit-test runner, and these modules are plain ESM.
 */

import { describe, test, expect } from '@jest/globals';
import {
    buildShareUrl, parseShareTarget, sameTarget,
} from '../../../frontend/src/utils/shareLink.js';

const BASE = 'https://polaris.mu/';

/** Round-trip, which is the property that actually matters. */
const roundTrip = (target) => {
    const url = buildShareUrl(BASE, target);
    return parseShareTarget(new URL(url).search);
};

describe('a link to a node', () => {
    test('carries the node', () => {
        expect(buildShareUrl(BASE, { nodeId: 'prov:group:abc' }))
            .toBe('https://polaris.mu/?node=prov%3Agroup%3Aabc');
    });

    test('and reads back as what went in', () => {
        expect(roundTrip({ nodeId: 'prov:group:abc' })).toEqual({
            nodeId: 'prov:group:abc',
            releaseId: null,
            guestId: null,
            musicalGuests: false,
            technicians: false,
        });
    });

    test('ids with colons survive, which is every id here', () => {
        const target = { nodeId: 'prov:person:54e096f1802dd625' };

        expect(roundTrip(target).nodeId).toBe(target.nodeId);
    });

    test('a base that already has a query is replaced, not appended to', () => {
        expect(buildShareUrl('https://polaris.mu/?node=old', { nodeId: 'new' }))
            .toBe('https://polaris.mu/?node=new');
    });
});

describe('a link to a guest', () => {
    const guest = {
        nodeId: 'prov:group:bradley',
        releaseId: 'prov:release:victim',
        guestId: 'prov:person:budos',
        musicalGuests: true,
    };

    test('names the group, the release and the guest', () => {
        // The group because the orbit only exists once it is selected; the
        // release because the chip only exists once it is open; the guest
        // because that is the thing being pointed at.
        expect(roundTrip(guest)).toMatchObject({
            nodeId: 'prov:group:bradley',
            releaseId: 'prov:release:victim',
            guestId: 'prov:person:budos',
        });
    });

    test('and the toggle that makes them visible at all', () => {
        expect(roundTrip(guest).musicalGuests).toBe(true);
    });
});

describe('the toggles', () => {
    test('are carried only when on', () => {
        // A link to an ordinary member should not carry flags that say
        // nothing; a reader who opens one keeps their own defaults.
        const url = buildShareUrl(BASE, { nodeId: 'n', musicalGuests: false, technicians: false });

        expect(url).not.toContain('musicalGuests');
        expect(url).not.toContain('technicians');
    });

    test('both travel when both are on', () => {
        const parsed = roundTrip({ nodeId: 'n', musicalGuests: true, technicians: true });

        expect(parsed.musicalGuests).toBe(true);
        expect(parsed.technicians).toBe(true);
    });

    test('a value that is not exactly true is not the flag', () => {
        for (const value of ['1', 'yes', 'TRUE', '']) {
            expect(parseShareTarget(`?node=n&technicians=${value}`).technicians).toBe(false);
        }
    });
});

describe('nothing to point at', () => {
    test('builds no link', () => {
        expect(buildShareUrl(BASE, null)).toBeNull();
        expect(buildShareUrl(BASE, {})).toBeNull();
        expect(buildShareUrl(BASE, { guestId: 'g' })).toBeNull();
    });

    test('and an ordinary visit parses as none', () => {
        expect(parseShareTarget('')).toBeNull();
        expect(parseShareTarget('?utm_source=somewhere')).toBeNull();
        expect(parseShareTarget(undefined)).toBeNull();
    });

    test('a guest id alone is not enough to open anything', () => {
        // Without the release there is no orbit, and without the group there
        // is no release. A chip is not reachable on its own.
        expect(parseShareTarget('?guest=prov:person:x')).toBeNull();
    });
});

describe('comparing targets', () => {
    test('same thing, whatever the toggles were', () => {
        expect(sameTarget(
            { nodeId: 'n', releaseId: 'r', guestId: null, musicalGuests: true },
            { nodeId: 'n', releaseId: 'r', guestId: null, musicalGuests: false },
        )).toBe(true);
    });

    test('different guest, different thing', () => {
        expect(sameTarget({ nodeId: 'n', guestId: 'a' }, { nodeId: 'n', guestId: 'b' }))
            .toBe(false);
    });

    test('nothing matches nothing, and nothing matches something', () => {
        expect(sameTarget(null, null)).toBe(true);
        expect(sameTarget(null, { nodeId: 'n' })).toBe(false);
    });
});
