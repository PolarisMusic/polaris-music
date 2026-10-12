/**
 * @fileoverview A track fingerprint identifies a recording on a release.
 *
 * Reported from production: Pearl Jam's "Ten" credited Pearl Jam, Queens Of
 * The Stone Age and The Aquabats! as performers, because the hidden track
 * "Untitled" was a single node shared by every release in the registry that
 * had one.
 *
 * trackFingerprint has always read `release_id`. Nothing passed it, so every
 * generated id reduced to the title alone — and the id in the offending event,
 * prov:track:a58439f1ca6ba6b3, is exactly what this file's first test shows a
 * scopeless "Untitled" produces. These pin the rule; the half that feeds it is
 * in normalizeReleaseBundle.test.js and in processReleaseBundle.
 */

import { describe, it, expect } from '@jest/globals';
import { IdentityService } from '../../src/identity/idService.js';

const id = (data) => IdentityService.makeProvisionalId(
    'track', IdentityService.trackFingerprint(data)
);

describe('trackFingerprint', () => {
    it('reduces to the title when no release is given', () => {
        // Not an assertion that this is desirable — it is the bug, pinned, so
        // that the id in the production event stays explicable to the next
        // reader. a58439f1ca6ba6b3 is the registry-wide "Untitled".
        expect(id({ title: 'Untitled' })).toBe('prov:track:a58439f1ca6ba6b3');
    });

    it('separates the same title on two releases', () => {
        expect(id({ title: 'Untitled', release_id: 'prov:release:ten' }))
            .not.toBe(id({ title: 'Untitled', release_id: 'prov:release:deaf' }));
    });

    it('is stable for the same title on the same release', () => {
        expect(id({ title: 'Untitled', release_id: 'prov:release:ten' }))
            .toBe(id({ title: 'Untitled', release_id: 'prov:release:ten' }));
    });

    it('normalizes the title, so case and spacing do not fork a node', () => {
        expect(id({ title: '  even   FLOW ', release_id: 'prov:release:ten' }))
            .toBe(id({ title: 'Even Flow', release_id: 'prov:release:ten' }));
    });

    it('accepts track_title as well as title', () => {
        // Call sites in this repo use both spellings; reading only one of them
        // is how the release fingerprint silently lost its date.
        expect(id({ track_title: 'Alive', release_id: 'prov:release:ten' }))
            .toBe(id({ title: 'Alive', release_id: 'prov:release:ten' }));
    });

    it('distinguishes two titles on one release', () => {
        expect(id({ title: 'Alive', release_id: 'prov:release:ten' }))
            .not.toBe(id({ title: 'Black', release_id: 'prov:release:ten' }));
    });
});
