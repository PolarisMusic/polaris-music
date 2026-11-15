/**
 * @jest-environment jsdom
 */
/**
 * What importing a module does before anybody asks it for anything.
 *
 * Two modules used to construct a singleton at module scope that nothing
 * imported. MusicGraph builds its own PathTracker and index.html builds its
 * own WalletManager, so the singletons were pure import side effects — and
 * not cheap ones. PathTracker's constructor reads the liked paths and two
 * hundred browse-history entries out of localStorage, synchronously, before
 * the graph has drawn anything. WalletManager's builds a SessionKit with a
 * WebRenderer and the full wallet plugin set, which is a 900kB chunk.
 *
 * Both showed in the console as every initialization line appearing twice,
 * which is how they were found.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = (relative) =>
    readFileSync(resolve(__dirname, '../../../frontend/src', relative), 'utf8');

describe('PathTracker', () => {
    beforeEach(() => {
        window.localStorage.clear();
        jest.restoreAllMocks();
    });

    test('importing it touches no storage', async () => {
        // The behavioural half: the constructor is what reads storage, so a
        // module that constructs nothing reads nothing.
        const getItem = jest.spyOn(Storage.prototype, 'getItem');

        await import('../../../frontend/src/visualization/PathTracker.js');

        expect(getItem).not.toHaveBeenCalled();
    });

    test('and still exports the class for the people who build one', async () => {
        const module = await import('../../../frontend/src/visualization/PathTracker.js');

        expect(typeof module.PathTracker).toBe('function');
    });

    test('constructing one does read storage, which is the cost being avoided', async () => {
        const { PathTracker } = await import('../../../frontend/src/visualization/PathTracker.js');
        const getItem = jest.spyOn(Storage.prototype, 'getItem');

        new PathTracker();

        expect(getItem).toHaveBeenCalled();
    });

    test('no instance is built at module scope', () => {
        // Source-level, because the import above is cached across tests and
        // a later reintroduction would not re-run it.
        expect(source('visualization/PathTracker.js'))
            .not.toMatch(/^\s*export const \w+ = new PathTracker\(/m);
    });
});

describe('WalletManager', () => {
    test('builds no instance at module scope', () => {
        // Checked on the source rather than by importing: the module pulls in
        // WharfKit, which expects a browser the test environment does not
        // fully provide. The cost being avoided is a second SessionKit, a
        // second WebRenderer and a second set of wallet plugins.
        expect(source('wallet/WalletManager.js'))
            .not.toMatch(/^\s*export const \w+ = new WalletManager\(/m);
    });

    test('and still exports the class', () => {
        expect(source('wallet/WalletManager.js')).toMatch(/export class WalletManager/);
    });
});
