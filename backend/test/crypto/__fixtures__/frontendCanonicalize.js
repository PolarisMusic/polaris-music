/**
 * Byte-for-byte mirror of `HashGenerator.canonicalize` from
 * frontend/src/utils/hashGenerator.js.
 *
 * The frontend package is not declared `type: "module"`, so Jest cannot
 * import it directly. Until the canonicalizer is unified (Stage C), we
 * mirror the function here and the determinism test asserts via source
 * inspection that this mirror matches the live frontend source.
 *
 * IF YOU EDIT THIS FILE, edit frontend/src/utils/hashGenerator.js too,
 * and vice versa. The drift guard in hashDeterminism.test.js will fail
 * loudly if the two get out of sync.
 */

export function canonicalize(obj) {
    if (obj === null || obj === undefined) {
        return JSON.stringify(obj);
    }

    if (typeof obj !== 'object') {
        return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
        return '[' + obj.map(item => canonicalize(item)).join(',') + ']';
    }

    // Sort object keys for determinism
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map(key => {
        return JSON.stringify(key) + ':' + canonicalize(obj[key]);
    });

    return '{' + pairs.join(',') + '}';
}
