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

describe('IdentityService.releaseFingerprint — issuing labels', () => {
    const base = { title: 'Bleach', release_date: '1989', format: 'LP' };

    it('separates a licensed reissue from the original pressing', () => {
        // Same title, same year, same format — a different label is the whole
        // of the difference, and it is a real one.
        const subpop = { ...base, labels: [{ name: 'Sub Pop', catalog_number: 'SP 34' }] };
        const geffen = { ...base, labels: [{ name: 'Geffen', catalog_number: 'GEF 24433' }] };
        expect(idFor(subpop)).not.toBe(idFor(geffen));
    });

    it('is independent of the order the labels arrive in', () => {
        // A release is co-issued *by a set* of labels; the order two names
        // happen to be typed in must not fork the node.
        const a = { ...base, labels: [{ name: 'Sub Pop' }, { name: 'Tupelo' }] };
        const b = { ...base, labels: [{ name: 'Tupelo' }, { name: 'Sub Pop' }] };
        expect(idFor(a)).toBe(idFor(b));
    });

    it('separates a co-issue from a single-label issue', () => {
        const single = { ...base, labels: [{ name: 'Sub Pop' }] };
        const coissue = { ...base, labels: [{ name: 'Sub Pop' }, { name: 'Tupelo' }] };
        expect(idFor(single)).not.toBe(idFor(coissue));
    });

    it('separates two issues by one label under different catalogue numbers', () => {
        const a = { ...base, labels: [{ name: 'Apple', catalog_number: 'PCS 7088' }] };
        const b = { ...base, labels: [{ name: 'Apple', catalog_number: 'PMC 7088' }] };
        expect(idFor(a)).not.toBe(idFor(b));
    });

    it('leaves an unlabelled release with the id it had before labels counted', () => {
        // An empty or missing list must contribute nothing, or every release
        // submitted without a label would have been re-identified.
        expect(idFor({ ...base, labels: [] })).toBe(idFor(base));
        expect(idFor({ ...base, labels: undefined })).toBe(idFor(base));
        expect(idFor({ ...base, labels: [{ name: '' }] })).toBe(idFor(base));
    });

    it('normalizes label names the way it normalizes every other name', () => {
        const a = { ...base, labels: [{ name: 'The Sub Pop' }] };
        const b = { ...base, labels: [{ name: 'sub pop' }] };
        expect(idFor(a)).toBe(idFor(b));
    });

    it('ignores a non-array labels value rather than throwing', () => {
        expect(() => idFor({ ...base, labels: 'Sub Pop' })).not.toThrow();
        expect(idFor({ ...base, labels: 'Sub Pop' })).toBe(idFor(base));
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

    it('threads the issuing labels through to the id', () => {
        const base = { name: 'Bleach', release_date: '1989', format: 'LP' };
        const subpop = { ...base, labels: [{ name: 'Sub Pop', catalog_number: 'SP 34' }] };
        const geffen = { ...base, labels: [{ name: 'Geffen', catalog_number: 'GEF 24433' }] };

        expect(db.generateProvisionalIdNew('release', subpop))
            .not.toBe(db.generateProvisionalIdNew('release', geffen));
        expect(db.generateProvisionalIdNew('release', subpop))
            .not.toBe(db.generateProvisionalIdNew('release', base));
    });

    it('stays idempotent, so replaying a bundle does not fork the node', () => {
        const data = { name: 'Rated R', release_date: '2000', format: 'CD' };
        expect(db.generateProvisionalIdNew('release', data))
            .toBe(db.generateProvisionalIdNew('release', data));
    });
});
