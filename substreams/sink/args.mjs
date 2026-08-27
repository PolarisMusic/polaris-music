/**
 * @fileoverview Substreams CLI argument construction for the HTTP sink.
 *
 * Lives in its own module so it can be imported by tests without executing
 * http-sink.mjs, which starts streaming as soon as it loads.
 *
 * @module sink/args
 */

/**
 * Normalize module-keyed params by stripping wrapping quotes from the value.
 *
 * spawn() passes argv verbatim — there is no shell to remove quotes — so
 * `map_anchored_events="polarismusic"` would reach the CLI with the quotes
 * still attached and match nothing.
 *
 * @param {string} params - e.g. `map_anchored_events=polarismusic`
 * @returns {string} the same string with any wrapping quotes removed
 */
export function normalizeModuleParams(params) {
    const eqIndex = params.indexOf('=');
    if (eqIndex === -1) {
        return params;
    }

    const moduleName = params.slice(0, eqIndex);
    let value = params.slice(eqIndex + 1);

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }

    return `${moduleName}=${value}`;
}

/**
 * Build the argv for `substreams run`.
 *
 * On the stop block: `0` means "follow the chain head indefinitely". Any other
 * value bounds the request, which is the only way to replay history.
 *
 * Providers cap how many blocks a single request may process
 * (`limit-processed-blocks`). An unbounded request always spans
 * startBlock → current head, and that span grows two blocks a second, so a
 * start block more than the cap behind head is refused outright:
 *
 *   FailedPrecondition: request needs to process a total of N blocks but only
 *   10000 are allowed according to the 'limit-processed-blocks' request argument
 *
 * A bounded range sidesteps that entirely: replaying 1,000 blocks around a
 * known transaction costs 1,000 blocks of allowance no matter how old it is.
 *
 * The stop block is passed through untouched so the CLI's relative form
 * (`+1000`, meaning 1000 blocks past the start) keeps working.
 *
 * @param {Object} config
 * @param {string} config.substreamsEndpoint
 * @param {string} config.substreamsPackage
 * @param {string} config.substreamsModule
 * @param {string} config.substreamsParams
 * @param {string} config.startBlock
 * @param {string} [config.stopBlock='0'] - `0` follows head; anything else bounds the run
 * @returns {string[]} argv for spawn('substreams', ...)
 */
export function buildSubstreamsArgs(config) {
    const rawParams = config.substreamsParams.includes('=')
        ? config.substreamsParams
        : `${config.substreamsModule}=${config.substreamsParams}`;

    const normalizedParams = normalizeModuleParams(rawParams);

    return [
        'run',
        '-e',
        config.substreamsEndpoint,
        config.substreamsPackage,
        config.substreamsModule,
        '--params',
        normalizedParams,
        '--start-block',
        String(config.startBlock),
        '--stop-block',
        String(config.stopBlock ?? '0'),
        '--output',
        'jsonl',
    ];
}
