/**
 * Unit tests for the destructive-graph-test guard.
 *
 * Pure unit tests: the "driver" is a stub, so these run everywhere rather than
 * only where GRAPH_URI is set. That matters — a guard that protects production
 * should not itself be gated behind having a database.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { assertDisposableGraph, OPT_IN } from './graphGuard.js';

/** Stub driver whose count query returns `nodes`, or rejects if `fail` is set. */
function stubDriver({ nodes = 0, fail = false } = {}) {
    const closed = { count: 0 };
    const driver = {
        session: () => ({
            run: async () => {
                if (fail) throw new Error('connection lost');
                return { records: [{ get: () => ({ toNumber: () => nodes }) }] };
            },
            close: async () => { closed.count++; }
        })
    };
    return { driver, closed };
}

describe('assertDisposableGraph', () => {
    let savedOptIn;
    let savedUri;

    beforeEach(() => {
        savedOptIn = process.env[OPT_IN];
        savedUri = process.env.GRAPH_URI;
        delete process.env[OPT_IN];
        process.env.GRAPH_URI = 'bolt://127.0.0.1:7687';
    });

    afterEach(() => {
        if (savedOptIn === undefined) delete process.env[OPT_IN];
        else process.env[OPT_IN] = savedOptIn;
        if (savedUri === undefined) delete process.env.GRAPH_URI;
        else process.env.GRAPH_URI = savedUri;
    });

    test('throws when the opt-in is absent', async () => {
        const { driver } = stubDriver({ nodes: 1247 });
        await expect(assertDisposableGraph(driver, 'Demo Suite'))
            .rejects.toThrow(/Refusing to run "Demo Suite"/);
    });

    test('names the target and the node count so the risk is concrete', async () => {
        const { driver } = stubDriver({ nodes: 1247 });
        await expect(assertDisposableGraph(driver, 'Demo Suite'))
            .rejects.toThrow(/bolt:\/\/127\.0\.0\.1:7687/);
        await expect(assertDisposableGraph(driver, 'Demo Suite'))
            .rejects.toThrow(/1,247 nodes/);
    });

    test('warns about the localhost/::1 tunnel trap', async () => {
        const { driver } = stubDriver({ nodes: 1 });
        await expect(assertDisposableGraph(driver, 'Demo Suite'))
            .rejects.toThrow(/::1/);
    });

    test('still refuses when the node count cannot be read', async () => {
        // A database we cannot even count is not a database we may delete.
        const { driver } = stubDriver({ fail: true });
        await expect(assertDisposableGraph(driver, 'Demo Suite'))
            .rejects.toThrow(/an unknown number of nodes/);
    });

    test('refuses an empty database too — emptiness is not consent', async () => {
        const { driver } = stubDriver({ nodes: 0 });
        await expect(assertDisposableGraph(driver, 'Demo Suite'))
            .rejects.toThrow(/Refusing to run/);
    });

    test('returns without throwing once opted in', async () => {
        process.env[OPT_IN] = 'true';
        const { driver } = stubDriver({ nodes: 1247 });
        await expect(assertDisposableGraph(driver, 'Demo Suite')).resolves.toBeUndefined();
    });

    test('opt-in must be exactly "true"', async () => {
        const { driver } = stubDriver({ nodes: 1 });
        for (const value of ['True', 'TRUE', '1', 'yes', '']) {
            process.env[OPT_IN] = value;
            await expect(assertDisposableGraph(driver, 'Demo Suite'))
                .rejects.toThrow(/Refusing to run/);
        }
    });

    test('does not touch the database when already opted in', async () => {
        process.env[OPT_IN] = 'true';
        const run = jest.fn();
        const driver = { session: () => ({ run, close: async () => {} }) };

        await assertDisposableGraph(driver, 'Demo Suite');

        expect(run).not.toHaveBeenCalled();
    });

    test('closes the session it opens', async () => {
        const { driver, closed } = stubDriver({ nodes: 5 });
        await expect(assertDisposableGraph(driver, 'Demo Suite')).rejects.toThrow();
        expect(closed.count).toBe(1);
    });
});
