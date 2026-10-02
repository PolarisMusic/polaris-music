/**
 * Back and forward over the browse log.
 *
 * The log is newest-first and doubles as the History panel's contents, so the
 * cursor is laid over it rather than replacing it with a browser-style stack.
 * The consequences of that choice are what these tests pin down — including the
 * one place it deliberately differs from a browser.
 */

import { PathTracker } from '../../../frontend/src/visualization/PathTracker.js';

/** A tracker with storage stubbed out; persistence is not what is under test. */
function tracker() {
    const t = new PathTracker();
    t.saveToStorage = () => {};
    return t;
}

function visit(t, ...ids) {
    for (const id of ids) t.recordBrowseVisit(id, { name: id, type: 'group' });
}

describe('where the cursor starts', () => {
    test('an empty log can go nowhere', () => {
        const t = tracker();
        expect(t.canGoBack()).toBe(false);
        expect(t.canGoForward()).toBe(false);
        expect(t.goBack()).toBeNull();
        expect(t.goForward()).toBeNull();
    });

    test('one visit is still nowhere to go', () => {
        const t = tracker();
        visit(t, 'a');
        expect(t.canGoBack()).toBe(false);
        expect(t.canGoForward()).toBe(false);
    });

    test('two visits can go back but not forward', () => {
        const t = tracker();
        visit(t, 'a', 'b');
        expect(t.canGoBack()).toBe(true);
        expect(t.canGoForward()).toBe(false);
    });
});

describe('stepping', () => {
    test('back walks into the past, newest first', () => {
        const t = tracker();
        visit(t, 'a', 'b', 'c');

        expect(t.goBack().nodeId).toBe('b');
        expect(t.goBack().nodeId).toBe('a');
    });

    test('forward retraces it', () => {
        const t = tracker();
        visit(t, 'a', 'b', 'c');
        t.goBack();
        t.goBack();

        expect(t.goForward().nodeId).toBe('b');
        expect(t.goForward().nodeId).toBe('c');
        expect(t.canGoForward()).toBe(false);
    });

    test('back at the end of the log does not move the cursor', () => {
        // Walking off the end would strand forward: the cursor would sit past
        // the last entry and forward would have to step twice to do anything.
        const t = tracker();
        visit(t, 'a', 'b');
        expect(t.goBack().nodeId).toBe('a');
        expect(t.goBack()).toBeNull();

        expect(t.goForward().nodeId).toBe('b');
    });

    test('forward at the present does not move either', () => {
        const t = tracker();
        visit(t, 'a', 'b');
        expect(t.goForward()).toBeNull();
        expect(t.goBack().nodeId).toBe('a');
    });

    test('the current entry follows the cursor, not the newest visit', () => {
        const t = tracker();
        visit(t, 'a', 'b', 'c');
        expect(t.currentHistoryEntry().nodeId).toBe('c');
        t.goBack();
        expect(t.currentHistoryEntry().nodeId).toBe('b');
    });
});

describe('a new visit while stepped back', () => {
    test('becomes the present', () => {
        const t = tracker();
        visit(t, 'a', 'b', 'c');
        t.goBack();
        t.goBack();
        visit(t, 'd');

        expect(t.currentHistoryEntry().nodeId).toBe('d');
        expect(t.canGoForward()).toBe(false);
    });

    test('does not discard what was ahead, unlike a browser', () => {
        // Deliberate: this log is also the History panel's contents, and
        // deleting somebody's browsing record to model a stack is the worse of
        // the two surprises. The entries stay; they are simply in the past now.
        const t = tracker();
        visit(t, 'a', 'b', 'c');
        t.goBack();
        t.goBack();
        visit(t, 'd');

        expect(t.getBrowseHistory().map((e) => e.nodeId)).toEqual(['d', 'c', 'b', 'a']);
        expect(t.goBack().nodeId).toBe('c');
    });
});

describe('the rules the log already had', () => {
    test('revisiting the newest entry is not recorded twice', () => {
        const t = tracker();
        visit(t, 'a', 'b', 'b');
        expect(t.getBrowseHistory().map((e) => e.nodeId)).toEqual(['b', 'a']);
    });

    test('a suppressed duplicate still puts the cursor at the present', () => {
        // Clicking the node you are already on, after stepping back, has to
        // mean "I am here now" even though nothing was appended.
        const t = tracker();
        visit(t, 'a', 'b');
        t.goBack();
        expect(t.currentHistoryEntry().nodeId).toBe('a');

        visit(t, 'b');
        expect(t.currentHistoryEntry().nodeId).toBe('b');
        expect(t.canGoForward()).toBe(false);
    });

    test('clearing resets the cursor as well as the entries', () => {
        const t = tracker();
        visit(t, 'a', 'b', 'c');
        t.goBack();
        t.clearBrowseHistory();

        expect(t.getBrowseHistory()).toEqual([]);
        expect(t.canGoBack()).toBe(false);
        expect(t.canGoForward()).toBe(false);
        expect(t.currentHistoryEntry()).toBeNull();
    });
});
