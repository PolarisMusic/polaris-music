/**
 * @fileoverview A one-at-a-time task queue for ordered event ingestion.
 *
 * Blockchain events must be applied in block order. An EDIT_CLAIM that reaches
 * the API before the CREATE_RELEASE_BUNDLE which creates its target can only
 * fail with "Target node not found" — and because the failure depends on which
 * HTTP request happens to finish first, it is intermittent. The same two events
 * succeeded on one replay and failed on the next.
 *
 * Node does not await promises returned from an event handler, so reading lines
 * off the substreams CLI's stdout and calling an async handler per line fans
 * them out concurrently. This serialises them instead.
 *
 * Lives in its own module because http-sink.mjs starts streaming as soon as it
 * is imported and so cannot be loaded from a test.
 *
 * @module sink/serialQueue
 */

/**
 * Create a queue that runs tasks strictly one after another, in the order they
 * were enqueued.
 *
 * @param {Object} [options]
 * @param {(error: Error) => void} [options.onError] - Called when a task
 *   rejects. The queue continues either way: one failed event must not stall
 *   the events behind it.
 * @returns {{ enqueue: (task: () => Promise<any>) => void, drain: () => Promise<void> }}
 */
export function createSerialQueue({ onError } = {}) {
    let chain = Promise.resolve();

    return {
        /**
         * Schedule a task. It starts only once every previously enqueued task
         * has settled.
         *
         * @param {() => Promise<any>} task
         */
        enqueue(task) {
            chain = chain.then(task).catch((error) => {
                if (onError) onError(error);
            });
        },

        /**
         * Resolve once everything enqueued so far has settled. Call before
         * reporting statistics or exiting, so nothing is killed in transit.
         *
         * @returns {Promise<void>}
         */
        drain() {
            return chain;
        }
    };
}
