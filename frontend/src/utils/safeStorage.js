/**
 * Safe wrappers around `window.localStorage` for browser persistence.
 *
 * Direct localStorage calls throw under several real-world conditions:
 *   - Safari Private Browsing rejects setItem with QuotaExceededError
 *   - Embedded WebViews and some sandboxed iframes deny access entirely
 *     (SecurityError when reading the property)
 *   - Storage quota exhausted (large path/like history)
 *   - Disabled storage in browser settings
 *
 * Before Stage D, every call site assumed localStorage worked. A throw
 * inside PathTracker.savePersistedData (called from a click handler)
 * was enough to stop the user-visible "like" flow mid-action. These
 * helpers swallow the error, log it once at debug level, and return a
 * sentinel value so callers can fall back to in-memory state.
 *
 * The helpers DO NOT mutate localStorage on the caller's behalf when
 * unavailable — there is no fallback storage. If storage is rejected
 * we behave as if the keyspace is empty.
 *
 * @module utils/safeStorage
 */

let warnedUnavailable = false;

function logUnavailable(operation, key, err) {
    // We log only the first failure per session at debug level — repeated
    // QuotaExceededErrors during a click-storm of likes would otherwise
    // flood the console.
    if (warnedUnavailable) return;
    warnedUnavailable = true;
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
        console.debug(
            `safeStorage: ${operation}(${key}) failed; further failures will be silent.`,
            err && err.message ? err.message : err
        );
    }
}

/**
 * Read a string from localStorage. Returns null if the key is absent
 * OR if storage is unavailable.
 *
 * @param {string} key
 * @returns {string|null}
 */
export function getItem(key) {
    try {
        return window.localStorage.getItem(key);
    } catch (err) {
        logUnavailable('getItem', key, err);
        return null;
    }
}

/**
 * Write a string to localStorage. Returns true on success, false if
 * storage rejected the write (quota, disabled, sandboxed, etc).
 *
 * Callers that care about durability MUST check the return value and
 * keep an in-memory copy. Callers that don't care can ignore it.
 *
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
export function setItem(key, value) {
    try {
        window.localStorage.setItem(key, value);
        return true;
    } catch (err) {
        logUnavailable('setItem', key, err);
        return false;
    }
}

/**
 * Remove a key. Returns true on success, false if storage rejected the
 * call. Callers can ignore the return value when best-effort is fine.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function removeItem(key) {
    try {
        window.localStorage.removeItem(key);
        return true;
    } catch (err) {
        logUnavailable('removeItem', key, err);
        return false;
    }
}

export default { getItem, setItem, removeItem };
