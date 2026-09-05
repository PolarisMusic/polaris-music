/**
 * Release fingerprint / edition separation.
 *
 * A Release node is one *edition* of a work. The original pressing, the CD
 * remaster and the deluxe reissue are three Releases sharing one Master, so
 * the provisional id has to distinguish them — otherwise the second
 * submission MERGEs onto the first and silently overwrites its format,
 * country and catalogue number.
 *
 * These are pure unit tests: no Neo4j, so they never skip.
 */

import { IdentityService } from '../../src/identity/idService.js';
import MusicGraphDatabase from '../../src/graph/schema.js';

const idFor = (data) =>
    IdentityService.makeProvisionalId('release', IdentityService.releaseFingerprint(data));

describe('IdentityService.releaseFingerprint', () => {
    const original = {
        title: 'Songs For The Deaf',
        release_date: '2002/08/27',
        format: 'CD',
        country: 'US'
    };

    it('is deterministic for identical input', () => {
        expect(idFor(original)).toBe(idFor({ ...original }));
    });

    it('separates two editions that differ only by date', () => {
        const remaster = { ...original, release_date: '2010/01/01' };
        expect(idFor(remaster)).not.toBe(idFor(original));
    });

    it('separates two editions that differ only by format', () => {
        const vinyl = { ...original, format: 'LP' };
        expect(idFor(vinyl)).not.toBe(idFor(original));
    });

    it('separates two editions that differ only by country', () => {
        const uk = { ...original, country: 'UK' };
        expect(idFor(uk)).not.toBe(idFor(original));
    });

    it('separates two editions that differ only by catalogue number', () => {
        const a = { ...original, catalog_number: 'INT 493 425-2' };
        const b = { ...original, catalog_number: '0694934252' };
        expect(idFor(a)).not.toBe(idFor(b));
        expect(idFor(a)).not.toBe(idFor(original));
    });

    it('reads the date under every spelling its callers use', () => {
        // `date` is the spelling MusicGraphDatabase passes; reading only
        // `release_date`/`year` dropped it from every fingerprint.
        const spellings = ['release_date', 'year', 'date'];
        for (const key of spellings) {
            const fp = IdentityService.releaseFingerprint({ title: 'A', [key]: '1999' });
            expect(fp.date).toBe('1999');
        }
    });

    it('omits absent discriminators rather than encoding them as null', () => {
        const fp = IdentityService.releaseFingerprint({ title: 'A', release_date: '1999' });
        expect(Object.keys(fp).sort()).toEqual(['date', 'title', 'type']);
    });
});

describe('MusicGraphDatabase.generateProvisionalIdNew (release)', () => {
    // Exercises the real call site, which is where the key-name mismatch lived.
    // A fingerprint fix that the caller does not feed is no fix at all.
    const db = Object.create(MusicGraphDatabase.prototype);

    it('threads date, format, country and catalogue number through to the id', () => {
        const base = {
            name: 'Songs For The Deaf',
            release_date: '2002/08/27',
            format: 'CD',
            country: 'US'
        };
        const variants = [
            { ...base, release_date: '2010/01/01' },
            { ...base, format: 'LP' },
            { ...base, country: 'UK' },
            { ...base, catalog_number: 'INT 493 425-2' }
        ];

        const baseId = db.generateProvisionalIdNew('release', base);
        for (const v of variants) {
            expect(db.generateProvisionalIdNew('release', v)).not.toBe(baseId);
        }
    });

    it('stays idempotent, so replaying a bundle does not fork the node', () => {
        const data = { name: 'Rated R', release_date: '2000', format: 'CD' };
        expect(db.generateProvisionalIdNew('release', data))
            .toBe(db.generateProvisionalIdNew('release', data));
    });
});
