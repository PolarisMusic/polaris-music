/**
 * Playback continuity across graph navigation.
 *
 * Selecting a node called loadQueue(), which tore down the audio element and
 * the Spotify embed before installing the new queue — so browsing the graph
 * silently stopped the music. Browsing and listening are separate activities,
 * and browsing is the main thing this page is for.
 *
 * The rule now: if something is sounding, the new queue waits. Pressing play
 * adopts it, which is the moment the user actually asks for the thing they
 * selected.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
    resolve(here, '../../../frontend/src/visualization/MiniPlayer.js'), 'utf8');

/**
 * Compile one method out of the class body so the test exercises the real
 * source rather than a copy, without needing a DOM or the module's imports.
 *
 * @param {string} name
 * @returns {Function}
 */
function compileMethod(name) {
    const start = SOURCE.indexOf(`\n    ${name}(`) >= 0
        ? SOURCE.indexOf(`\n    ${name}(`)
        : SOURCE.indexOf(`\n    async ${name}(`);
    if (start < 0) throw new Error(`method ${name} not found`);

    // Walk braces to the method's end.
    const open = SOURCE.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < SOURCE.length; i++) {
        if (SOURCE[i] === '{') depth++;
        else if (SOURCE[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = SOURCE.slice(start, i + 1).trim();
    const isAsync = body.startsWith('async');
    const sig = body.slice(isAsync ? 6 : 0);
    return eval(`(${isAsync ? 'async ' : ''}function ${sig})`);
}

function makePlayer({ isPlaying = false, embedMode = false } = {}) {
    return {
        _isPlaying: isPlaying,
        _embedMode: embedMode,
        _pendingQueue: null,
        queue: [],
        currentIndex: -1,
        context: null,
        api: { fetchPlaybackQueue: jest.fn() },
        _isSounding: compileMethod('_isSounding'),
        _applyQueue: compileMethod('_applyQueue'),
        _stopAudio: jest.fn(),
        _exitEmbedMode: jest.fn(),
        _show: jest.fn(),
        _updateTrackDisplay: jest.fn(),
        _updateQueueDrawer: jest.fn(),
        _updatePlayButton: jest.fn(),
    };
}

const RESPONSE = {
    success: true,
    context: { name: 'Nevermind', type: 'release' },
    queue: [{ track_id: 't1', track_name: 'In Bloom' }],
};

describe('loadQueue while something is sounding', () => {
    let loadQueue;
    beforeEach(() => { loadQueue = compileMethod('loadQueue'); });

    test('replaces the queue when nothing is playing', async () => {
        const p = makePlayer();
        p.api.fetchPlaybackQueue.mockResolvedValue(RESPONSE);

        await loadQueue.call(p, 'release', 'rel:1');

        expect(p.queue).toHaveLength(1);
        expect(p.currentIndex).toBe(0);
        expect(p._pendingQueue).toBeNull();
    });

    test('does not stop audio that is playing', async () => {
        const p = makePlayer({ isPlaying: true });
        p.queue = [{ track_id: 'old', track_name: 'Lithium' }];
        p.currentIndex = 0;
        p.api.fetchPlaybackQueue.mockResolvedValue(RESPONSE);

        await loadQueue.call(p, 'release', 'rel:2');

        expect(p._stopAudio).not.toHaveBeenCalled();
        expect(p._exitEmbedMode).not.toHaveBeenCalled();
        expect(p.queue[0].track_id).toBe('old');
    });

    test('does not tear down a Spotify embed', async () => {
        // _isPlaying only tracks the <audio> element; an embed plays inside an
        // iframe we cannot query, so its presence is the signal.
        const p = makePlayer({ embedMode: true });
        p.api.fetchPlaybackQueue.mockResolvedValue(RESPONSE);

        await loadQueue.call(p, 'release', 'rel:2');

        expect(p._exitEmbedMode).not.toHaveBeenCalled();
        expect(p._pendingQueue).not.toBeNull();
    });

    test('stages the new queue for the play button to adopt', async () => {
        const p = makePlayer({ isPlaying: true });
        p.api.fetchPlaybackQueue.mockResolvedValue(RESPONSE);

        await loadQueue.call(p, 'release', 'rel:2');

        expect(p._pendingQueue.context.name).toBe('Nevermind');
        // The button has to say it will switch, or the change is a surprise.
        expect(p._updatePlayButton).toHaveBeenCalled();
    });

    test('a failed fetch changes nothing', async () => {
        const p = makePlayer({ isPlaying: true });
        p.api.fetchPlaybackQueue.mockResolvedValue({ success: false });

        await loadQueue.call(p, 'release', 'rel:2');

        expect(p._pendingQueue).toBeNull();
        expect(p._stopAudio).not.toHaveBeenCalled();
    });
});

describe('_applyQueue', () => {
    test('clears any pending queue as it installs one', () => {
        const p = makePlayer();
        p._pendingQueue = { context: {}, queue: [] };

        p._applyQueue.call(p, RESPONSE.context, RESPONSE.queue);

        expect(p._pendingQueue).toBeNull();
        expect(p.currentIndex).toBe(0);
        expect(p._stopAudio).toHaveBeenCalled();
    });

    test('an empty queue leaves no current track', () => {
        const p = makePlayer();
        p._applyQueue.call(p, RESPONSE.context, []);
        expect(p.currentIndex).toBe(-1);
    });
});
