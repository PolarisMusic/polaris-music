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
 * Modules the sink is allowed to run.
 *
 * Everything here reaches the chain through `antelope:filtered_actions`, so
 * the provider filters to one contract's actions before anything crosses the
 * wire. The package also contains `map_events`, which takes
 * `source: sf.antelope.type.v1.Block` — every block on the chain — along with
 * `store_stats`, `store_account_activity` and `map_stats`, which read from it
 * and are therefore full-block consumers too. None of those are called by
 * anything; they exist in the manifest only.
 *
 * They are a live hazard all the same: SUBSTREAMS_MODULE is an environment
 * variable, and pointing it at one of them would silently stream the whole of
 * Jungle4 through a metered connection. Nothing in the sink would complain —
 * it would simply run, cost money, and look like it was working.
 *
 * So the allowlist is the enforcement point. Adding a module here is a
 * deliberate act; typo-ing an env var is not.
 *
 * @constant {Set<string>}
 */
export const FILTERED_MODULES = new Set([
    // Local package: consumes antelope:filtered_actions (substreams.yaml:121).
    'map_anchored_events',
    // Pinax antelope-common foundational module, used by the fallback path.
    'filtered_actions',
]);

/**
 * Reject any module that would stream unfiltered blocks.
 *
 * Throws rather than warning: a warning in a container log is a warning nobody
 * reads until the invoice arrives.
 *
 * @param {string} moduleName
 * @throws {Error} if the module is not a known filtered module
 */
export function assertFilteredModule(moduleName) {
    if (FILTERED_MODULES.has(moduleName)) return;

    throw new Error(
        `Refusing to run Substreams module "${moduleName}": it is not a ` +
        'filtered module.\n\n' +
        'This sink only runs modules that consume antelope:filtered_actions, ' +
        'so the provider filters to one contract before data crosses the ' +
        'wire. Modules reading `source: sf.antelope.type.v1.Block` ' +
        '(map_events, and store_stats / store_account_activity / map_stats ' +
        'which derive from it) would stream every block on the chain.\n\n' +
        `Allowed: ${[...FILTERED_MODULES].join(', ')}\n` +
        'Set SUBSTREAMS_MODULE to one of those, or add the module to ' +
        'FILTERED_MODULES in sink/args.mjs if it really is filtered.'
    );
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
    // Before anything else: a full-block module must not reach the provider.
    assertFilteredModule(config.substreamsModule);

    const rawParams = config.substreamsParams.includes('=')
        ? config.substreamsParams
        : `${config.substreamsModule}=${config.substreamsParams}`;

    const normalizedParams = normalizeModuleParams(rawParams);

    const args = [
        'run',
        '-e',
        config.substreamsEndpoint,
        config.substreamsPackage,
        config.substreamsModule,
        '--params',
        normalizedParams,
    ];

    // map_anchored_events consumes antelope:filtered_actions, which applies the
    // query from ITS OWN params — the whole point of the foundational module is
    // that the provider filters before anything crosses the wire. Params are
    // per-module, so passing only map_anchored_events' would leave the filter
    // unset and stream every block, which is the state we just measured at
    // 3.8 MiB per empty 10,000-block window.
    //
    // Only for the local module: the Pinax-module fallback path already targets
    // filtered_actions directly and carries its own query.
    if (config.substreamsModule === 'map_anchored_events') {
        const query = normalizedParams.slice(normalizedParams.indexOf('=') + 1);
        args.push('--params', `antelope:filtered_actions=${query}`);
    }

    // Index-based block skipping only happens in production mode. Development
    // mode — the default — streams every block to the client so you can debug,
    // which is why three successive filtering changes left egress flat at
    // 3.8 MiB per empty 10,000-block window and `Received Blocks: 10,000`.
    // Production mode also caches module output server-side, so a repeated
    // range stops being recomputed from raw blocks.
    //
    // Opt-out exists because it changes streaming shape: production mode
    // backprocesses in parallel and emits once segments complete, rather than
    // strictly block-by-block. That is what you want for both a replay and a
    // deployed tail, but a debugging session may want the old behaviour.
    if (process.env.SUBSTREAMS_DEV_MODE !== 'true') {
        args.push('--production-mode');
    }

    args.push(
        '--start-block',
        String(config.startBlock),
        '--stop-block',
        String(config.stopBlock ?? '0'),
        '--output',
        'jsonl',
    );

    return args;
}
