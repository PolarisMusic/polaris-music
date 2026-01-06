#!/usr/bin/env node
/**
 * @fileoverview HTTP Sink for Polaris Substreams
 *
 * Consumes anchored events from Substreams and posts them to the backend ingestion endpoint.
 * Implements retry logic with exponential backoff for resilience.
 *
 * Requires Node 18+ (uses global fetch API)
 *
 * Usage:
 *   node http-sink.mjs --endpoint=http://localhost:3000 --contract=polaris
 *   node http-sink.mjs --help
 *
 * Environment Variables:
 *   BACKEND_URL         - Backend ingestion endpoint (default: http://localhost:3000)
 *   SUBSTREAMS_ENDPOINT - Firehose endpoint (default: eos.firehose.pinax.network:443)
 *   SUBSTREAMS_API_TOKEN - Pinax API token (required)
 *   START_BLOCK         - Starting block number (default: 0)
 *   CONTRACT_ACCOUNT    - Contract account name (default: polaris)
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const config = {
    backendUrl: process.env.BACKEND_URL || 'http://localhost:3000',
    substreamsEndpoint: process.env.SUBSTREAMS_ENDPOINT || 'jungle4.substreams.pinax.network:443',
    // Accept either SUBSTREAMS_API_TOKEN or SUBSTREAMS_API_KEY (TOKEN preferred)
    apiToken: process.env.SUBSTREAMS_API_TOKEN || process.env.SUBSTREAMS_API_KEY || '',
    startBlock: process.env.START_BLOCK || '0',
    contractAccount: process.env.CONTRACT_ACCOUNT || 'polaris',

    // Substreams package configuration (Pinax Antelope foundational modules)
    // Using stable .spkg URL (more reliable than shorthand registry ref)
    //
    // IMPORTANT: Action decoding (jsonData) requires contract ABI availability
    // - Pinax may not have ABIs for custom contracts by default
    // - If action.jsonData is empty, the sink cannot extract the 'hash' field
    // - This will cause ingestion to fail with clear error messages
    //
    // Current package: antelope-common with filtered_actions module
    // - Outputs: sf.antelope.type.v1.ActionTrace with decoded actions (if ABI available)
    // - Alternative: Consider Pinax packages with ABI resolution if decoding fails
    //
    substreamsPackage: process.env.SUBSTREAMS_PACKAGE || 'https://spkg.io/pinax-network/antelope-common-v0.4.0.spkg',
    substreamsModule: process.env.SUBSTREAMS_MODULE || 'filtered_actions',
    substreamsParams: process.env.SUBSTREAMS_PARAMS || '', // Will be set from contractAccount if empty

    maxRetries: 5,
    retryDelayMs: 1000,
    requestTimeoutMs: 10000, // 10 second timeout
};

// Utility: Sanitize backend URL (strip trailing /api if present)
function sanitizeBackendUrl(url) {
    // Remove trailing slash
    let sanitized = url.replace(/\/$/, '');
    // Remove trailing /api (will be added back when constructing full endpoint)
    if (sanitized.endsWith('/api')) {
        sanitized = sanitized.slice(0, -4);
    }
    return sanitized;
}

// Parse command-line arguments
for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
        console.log(`
Polaris Substreams HTTP Sink
=============================

Usage:
  node http-sink.mjs [options]

Options:
  --endpoint=<url>       Backend base URL (default: http://localhost:3000)
                         NOTE: Do not include /api suffix - it will be added automatically
  --contract=<account>   Contract account name (default: polaris)
  --start-block=<num>    Starting block number (default: 0)
  --help, -h             Show this help message

Environment Variables:
  BACKEND_URL            Backend base URL (without /api suffix)
  SUBSTREAMS_ENDPOINT    Substreams endpoint (default: jungle4.substreams.pinax.network:443)
  SUBSTREAMS_API_TOKEN   Pinax API token (REQUIRED - get from https://app.pinax.network)
  SUBSTREAMS_API_KEY     Alias for SUBSTREAMS_API_TOKEN (either works)
  SUBSTREAMS_PACKAGE     Substreams package (default: https://spkg.io/pinax-network/antelope-common-v0.4.0.spkg)
  SUBSTREAMS_MODULE      Module to run (default: filtered_actions)
  SUBSTREAMS_PARAMS      Filter params (default: code:CONTRACT_ACCOUNT && action:put)
  START_BLOCK            Starting block number
  CONTRACT_ACCOUNT       Contract account name

Example:
  SUBSTREAMS_API_TOKEN=your_token node http-sink.mjs --endpoint=http://localhost:3000
        `);
        process.exit(0);
    } else if (arg.startsWith('--endpoint=')) {
        config.backendUrl = sanitizeBackendUrl(arg.split('=')[1]);
    } else if (arg.startsWith('--contract=')) {
        config.contractAccount = arg.split('=')[1];
    } else if (arg.startsWith('--start-block=')) {
        config.startBlock = arg.split('=')[1];
    }
}

// Sanitize backendUrl from environment variable
config.backendUrl = sanitizeBackendUrl(config.backendUrl);

// Set default substreams params if not provided
if (!config.substreamsParams) {
    config.substreamsParams = `code:${config.contractAccount} && action:put`;
}

// Validation
if (!config.apiToken) {
    console.error('ERROR: SUBSTREAMS_API_TOKEN (or SUBSTREAMS_API_KEY) environment variable is required');
    console.error('Get your API key from https://app.pinax.network');
    console.error('');
    console.error('Run "node http-sink.mjs --help" for usage information');
    process.exit(1);
}

console.log('Polaris Substreams HTTP Sink');
console.log('============================');
console.log(`Backend URL:         ${config.backendUrl}`);
console.log(`Substreams Endpoint: ${config.substreamsEndpoint}`);

// Extract provider from endpoint for logging
const providerHost = config.substreamsEndpoint.split(':')[0];
const isPinax = providerHost.includes('pinax.network');
console.log(`Provider:            ${isPinax ? 'Pinax' : 'Custom'} (${providerHost})`);
console.log(`API Token:           ${config.apiToken ? '✓ Configured' : '✗ Missing'}`);
console.log('');

// Detect ingestion mode (local vs Pinax)
const isLocalPackage = config.substreamsPackage.includes('polaris_music_substreams');
const isLocalModule = config.substreamsModule === 'map_anchored_events';

if (isLocalPackage && isLocalModule) {
    console.log('Mode:                Local (map_anchored_events with embedded ABI)');
    console.log('                     ✓ No dependency on Pinax ABI availability');
} else if (config.substreamsModule === 'filtered_actions') {
    console.log('Mode:                Pinax (filtered_actions)');
    console.log('                     ⚠ Requires Pinax to have contract ABI for decoding');
} else {
    console.log('Mode:                Custom');
}
console.log('');

console.log(`Substreams Package:  ${config.substreamsPackage}`);
console.log(`Substreams Module:   ${config.substreamsModule}`);
console.log(`Filter Params:       ${config.substreamsParams}`);
console.log(`Contract Account:    ${config.contractAccount}`);
console.log(`Start Block:         ${config.startBlock}`);
console.log('');

// Statistics
const stats = {
    eventsReceived: 0,
    eventsPosted: 0,
    eventsFailed: 0,
    retries: 0,
};

/**
 * Normalize hash value to string (defensive)
 * Handles: string, byte array, object with hex field, null, undefined
 *
 * @param {string|Array|Object|null|undefined} value - Hash in various formats
 * @returns {string|null} Normalized hash string or null if invalid
 */
function normalizeHashString(value) {
    if (!value) {
        return null;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        // Byte array
        try {
            return Buffer.from(value).toString('hex');
        } catch (error) {
            return null;
        }
    }

    if (typeof value === 'object' && value.hex) {
        return typeof value.hex === 'string' ? value.hex : null;
    }

    return null;
}

/**
 * Safe hash preview for logging (never throws)
 * Returns a truncated preview or placeholder for missing hashes
 *
 * @param {string|Array|Object|null|undefined} value - Hash in various formats
 * @param {number} n - Number of characters to show (default: 8)
 * @returns {string} Preview string like "abcd1234..." or "<no-hash>"
 */
function safeHashPreview(value, n = 8) {
    const normalized = normalizeHashString(value);

    if (!normalized) {
        return '<no-hash>';
    }

    if (normalized.length <= n) {
        return normalized;
    }

    return normalized.substring(0, n) + '...';
}

/**
 * Normalize module-keyed params by stripping wrapping quotes from value
 * Handles params like: module="value" or module='value' or module=value
 *
 * CRITICAL: When using spawn() with argv array (not shell), quotes are NOT
 * automatically stripped. This function removes a single pair of wrapping
 * quotes to prevent them from being passed literally to the substreams CLI.
 *
 * @param {string} params - Module-keyed params string
 * @returns {string} Normalized params without wrapping quotes on value
 */
function normalizeModuleParams(params) {
    // Split on first '=' to get module name and value
    const eqIndex = params.indexOf('=');
    if (eqIndex === -1) {
        // No '=' means not module-keyed, return as-is
        return params;
    }

    const moduleName = params.slice(0, eqIndex);
    let value = params.slice(eqIndex + 1);

    // Strip a single pair of wrapping quotes (either " or ')
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }

    return `${moduleName}=${value}`;
}

/**
 * Post anchored event to backend with retry logic
 *
 * Uses AbortController for timeout (Node 18+ compatible)
 *
 * @param {Object} anchoredEvent - AnchoredEvent protobuf object
 * @param {number} attempt - Current retry attempt (1-indexed)
 * @returns {Promise<boolean>} Success status
 */
async function postAnchoredEvent(anchoredEvent, attempt = 1) {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    try {
        const response = await fetch(`${config.backendUrl}/api/ingest/anchored-event`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(anchoredEvent),
            signal: controller.signal, // AbortController signal for timeout
        });

        clearTimeout(timeoutId); // Clear timeout on success

        if (response.ok) {
            const result = await response.json();
            console.log(
                `✓ Posted event ${safeHashPreview(anchoredEvent.content_hash || anchoredEvent.event_hash, 8)} ` +
                `(block ${anchoredEvent.block_num}, action: ${anchoredEvent.action_name})`
            );
            stats.eventsPosted++;
            return true;
        } else {
            const errorText = await response.text();
            console.error(
                `✗ Failed to post event ${safeHashPreview(anchoredEvent.content_hash || anchoredEvent.event_hash, 8)}`,
                `HTTP ${response.status}: ${errorText}`
            );

            // Retry on server errors (5xx) or rate limit (429)
            if ((response.status >= 500 || response.status === 429) && attempt < config.maxRetries) {
                const delayMs = config.retryDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
                console.log(`  Retrying in ${delayMs}ms (attempt ${attempt + 1}/${config.maxRetries})...`);
                stats.retries++;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                return postAnchoredEvent(anchoredEvent, attempt + 1);
            }

            stats.eventsFailed++;
            return false;
        }
    } catch (error) {
        clearTimeout(timeoutId); // Clear timeout on error

        // Handle AbortController timeout
        if (error.name === 'AbortError') {
            console.error(
                `✗ Timeout posting event ${safeHashPreview(anchoredEvent.content_hash || anchoredEvent.event_hash, 8)} ` +
                `(exceeded ${config.requestTimeoutMs}ms)`
            );
        } else {
            console.error(
                `✗ Network error posting event ${safeHashPreview(anchoredEvent.content_hash || anchoredEvent.event_hash, 8)}:`,
                error.message
            );
        }

        // Retry on network errors and timeouts
        if (attempt < config.maxRetries) {
            const delayMs = config.retryDelayMs * Math.pow(2, attempt - 1);
            console.log(`  Retrying in ${delayMs}ms (attempt ${attempt + 1}/${config.maxRetries})...`);
            stats.retries++;
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return postAnchoredEvent(anchoredEvent, attempt + 1);
        }

        stats.eventsFailed++;
        return false;
    }
}

/**
 * Process Substreams output line by line
 *
 * Handles two output format variants:
 * 1. Wrapped format (default): { "@module": "...", "@type": "...", "@data": { ... } }
 * 2. Plain format (with --plain-output flag): { "events": [...] } or { "actionTraces": [...] }
 *
 * Supports two module types:
 * - ActionTraces from Pinax filtered_actions module (sf.antelope.type.v1.ActionTraces)
 * - AnchoredEvents from local map_anchored_events module (polaris.v1.AnchoredEvents)
 *
 * @param {string} line - JSON line from Substreams output
 */
async function processLine(line) {
    try {
        const data = JSON.parse(line);

        // Support two output formats to prevent silent ingestion failure:
        // 1. Wrapped: { "@module": "...", "@type": "...", "@data": { ... } }
        // 2. Plain: { "events": [...] } or { "actionTraces": [...] } (from --plain-output)

        let dataPayload;
        let moduleName;
        let typeName;

        if (data['@data']) {
            // Wrapped format (standard Substreams output)
            dataPayload = data['@data'];
            moduleName = data['@module'];
            typeName = data['@type'];
        } else if (data.events || data.actionTraces) {
            // Plain format - treat object itself as payload
            // This happens when --plain-output strips wrapper keys
            dataPayload = data;
            // Infer module/type from payload structure
            if (data.events) {
                moduleName = 'map_anchored_events';
                typeName = 'polaris.v1.AnchoredEvents';
            } else if (data.actionTraces) {
                moduleName = 'filtered_actions';
                typeName = 'sf.antelope.type.v1.ActionTraces';
            }
        } else {
            // Neither wrapped nor recognized plain format - skip
            return;
        }

        // Detect output format by type or module name or payload structure
        const isAnchoredEvents =
            typeName === 'polaris.v1.AnchoredEvents' ||
            moduleName === 'map_anchored_events' ||
            dataPayload.events;

        if (isAnchoredEvents) {
            // Format: { "events": [...] }
            await processAnchoredEventsOutput(dataPayload);
        } else if (moduleName === config.substreamsModule || dataPayload.actionTraces) {
            // Format: { "actionTraces": [...] }
            await processActionTracesOutput(dataPayload);
        }
    } catch (error) {
        // Ignore parse errors for progress messages and other non-JSON lines
        if (!line.startsWith('Progress:') && !line.startsWith('Block:')) {
            console.error('Error processing line:', error.message);
        }
    }
}

/**
 * Process AnchoredEvents output from map_anchored_events module
 * This is the preferred format with embedded ABI and clean event structure
 *
 * @param {Object} data - AnchoredEvents data with events array
 */
async function processAnchoredEventsOutput(data) {
    const events = data.events || [];

    for (const event of events) {
        stats.eventsReceived++;

        // Decode payload from base64 bytes to UTF-8 JSON string
        let payloadStr;
        if (typeof event.payload === 'string') {
            // Already a string (base64)
            try {
                payloadStr = Buffer.from(event.payload, 'base64').toString('utf-8');
            } catch (error) {
                console.error(`✗ Failed to decode base64 payload:`, error.message);
                stats.eventsFailed++;
                continue;
            }
        } else if (Array.isArray(event.payload)) {
            // Byte array
            payloadStr = Buffer.from(event.payload).toString('utf-8');
        } else {
            console.error(`✗ Invalid payload format:`, typeof event.payload);
            stats.eventsFailed++;
            continue;
        }

        // Build AnchoredEvent structure for backend (already in correct format!)
        // The proto uses snake_case which matches backend expectations
        const postableEvent = {
            content_hash: event.content_hash || event.contentHash,
            event_hash: event.event_hash || event.eventHash,
            payload: payloadStr,
            block_num: event.block_num || event.blockNum,
            block_id: event.block_id || event.blockId,
            trx_id: event.trx_id || event.trxId,
            action_ordinal: event.action_ordinal || event.actionOrdinal,
            timestamp: event.timestamp,
            source: event.source || 'substreams',
            contract_account: event.contract_account || event.contractAccount,
            action_name: event.action_name || event.actionName,
        };

        console.log(
            `  Received ${postableEvent.action_name} event: ` +
            `${safeHashPreview(postableEvent.content_hash, 12)} ` +
            `(block ${postableEvent.block_num})`
        );

        await postAnchoredEvent(postableEvent);
    }
}

/**
 * Process ActionTraces output from filtered_actions module (Pinax antelope-common)
 * This format requires endpoint ABI decoding and is less reliable for custom contracts
 *
 * @param {Object} data - ActionTraces data with actionTraces array
 */
async function processActionTracesOutput(data) {
    const actionTraces = data.actionTraces || [];

    for (const actionTrace of actionTraces) {
                stats.eventsReceived++;

                // Extract action data from ActionTrace format
                // filtered_actions returns sf.antelope.type.v1.ActionTrace
                const action = actionTrace.action;
                if (!action) {
                    console.warn('  Skipping action trace without action data');
                    continue;
                }

                // Extract the 'put' action data (our contract's anchoring action)
                // jsonData field from proto is json_data → jsonData in JSON
                // CRITICAL: jsonData is only populated if Pinax has the contract ABI for decoding
                // Handle three cases: string (needs parsing), object (already parsed), or undefined
                let actionData;
                const actionName = action.name || 'unknown';
                const actionAccount = action.account || 'unknown';

                if (typeof action.jsonData === 'string') {
                    try {
                        actionData = JSON.parse(action.jsonData);
                    } catch (error) {
                        console.error(`✗ Failed to parse jsonData for ${actionAccount}::${actionName}:`, error.message);
                        console.error(`  This may indicate corrupted Substreams output or encoding issues`);
                        continue;
                    }
                } else if (typeof action.jsonData === 'object' && action.jsonData !== null) {
                    actionData = action.jsonData;
                } else if (action.data) {
                    // Fallback to raw data if jsonData is not available
                    // NOTE: This likely means the contract ABI is not available to Pinax
                    console.warn(`⚠ No jsonData for ${actionAccount}::${actionName}, using raw action.data`);
                    console.warn(`  Raw data cannot be reliably decoded without ABI - will likely fail hash extraction`);
                    actionData = action.data;
                } else {
                    console.error(`✗ No parseable data for ${actionAccount}::${actionName}`);
                    console.error(`  Neither action.jsonData nor action.data are available`);
                    continue;
                }

                // Ensure we have a content hash (required field for backend ingestion)
                // This field comes from the decoded 'put' action payload
                if (!actionData.hash) {
                    console.error(`✗ Missing required 'hash' field in action data`);
                    console.error(`  Action: ${actionAccount}::${actionName}`);
                    console.error(`  Block: ${actionTrace.blockNum}, Tx: ${actionTrace.transactionId || 'unknown'}`);
                    console.error(`  Data keys available: ${Object.keys(actionData).join(', ') || 'none'}`);
                    console.error(`  `);
                    console.error(`  LIKELY CAUSE: Contract ABI not available to Pinax for action decoding`);
                    console.error(`  SOLUTION: Ensure '${actionAccount}' contract ABI is published or available to Pinax`);
                    console.error(`  Alternatively, consider using a Pinax package with ABI resolution support`);
                    stats.eventsFailed++;
                    continue;
                }

                // Build AnchoredEvent structure expected by backend
                // Maps from Antelope ActionTrace to our ingestion format
                // CRITICAL: Use correct proto JSON field names:
                //   - transaction_id → transactionId (NOT trxId)
                //   - producer_block_id → producerBlockId (NOT blockId)
                const postableEvent = {
                    content_hash: actionData.hash,  // The content hash from put action
                    event_hash: actionData.hash,    // Use same for now (can derive from action data if needed)
                    payload: JSON.stringify(actionData), // The full action data
                    block_num: actionTrace.blockNum,
                    block_id: actionTrace.producerBlockId,
                    trx_id: actionTrace.transactionId,
                    action_ordinal: actionTrace.actionOrdinal || actionTrace.executionIndex,
                    timestamp: actionTrace.blockTime,
                    source: 'substreams',
                    contract_account: action.account,
                    action_name: action.name,
                };

                await postAnchoredEvent(postableEvent);
            }
        }
    } catch (error) {
        // Ignore parse errors for progress messages and other non-JSON lines
        if (!line.startsWith('Progress:') && !line.startsWith('Block:')) {
            console.error('Error processing line:', error.message);
        }
    }
}

/**
 * Check if substreams binary is available (portable, no dependency on 'which')
 * @returns {Promise<boolean>} True if available
 */
async function checkSubstreamsBinary() {
    return new Promise((resolve) => {
        // Probe with --version instead of 'which' for better portability
        // Works on slim images where 'which' might be missing
        const checkProcess = spawn('substreams', ['--version']);

        let versionOutput = '';

        checkProcess.stdout.on('data', (data) => {
            versionOutput += data.toString();
        });

        checkProcess.on('close', (code) => {
            if (code === 0 && versionOutput) {
                // Log version for visibility at startup
                const versionLine = versionOutput.split('\n')[0].trim();
                console.log(`Found ${versionLine}`);
            }
            resolve(code === 0);
        });

        checkProcess.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Main function: Run Substreams and pipe output to HTTP sink
 */
async function main() {
    // Check if substreams binary is available
    const hasSubstreams = await checkSubstreamsBinary();
    if (!hasSubstreams) {
        console.error('ERROR: substreams binary not found in PATH');
        console.error('');
        console.error('The substreams CLI is required to run this sink.');
        console.error('');
        console.error('Installation options:');
        console.error('  1. Install via: curl https://substreams.streamingfast.io/install.sh | bash');
        console.error('  2. Download from: https://github.com/streamingfast/substreams/releases');
        console.error('  3. Use the provided Docker image (see docker-compose.yml)');
        console.error('');
        process.exit(1);
    }

    console.log('Starting Substreams...');
    console.log('');

    // Build substreams command using Pinax Antelope foundational modules
    // Package: https://spkg.io/pinax-network/antelope-common-v0.4.0.spkg (stable .spkg URL)
    //   OR: Local package at /app/substreams/polaris_music_substreams.spkg (custom ABI)
    // Module: filtered_actions (Pinax) OR map_anchored_events (local custom)
    //
    // CRITICAL: Params must be module-keyed for parameterized modules
    //   Format: --params <module_name>=<value>
    //   Example: --params map_anchored_events=polaris
    //   Example: --params filtered_actions=code:polaris && action:put
    //   NOT: --params "code:polaris && action:put" (missing module name)
    //
    // Current behavior:
    //   - If SUBSTREAMS_PARAMS contains "=", assume it's module-keyed and normalize it
    //   - Otherwise, prefix with module name (for backwards compatibility)
    //   - normalizeModuleParams() strips wrapping quotes from spawn() argv (not a shell)

    // Build raw params (possibly with quotes from env var)
    const rawParams = config.substreamsParams.includes('=')
        ? config.substreamsParams
        : `${config.substreamsModule}=${config.substreamsParams}`;

    // Normalize params (strip wrapping quotes that would be passed literally via spawn)
    const normalizedParams = normalizeModuleParams(rawParams);

    const substreamsArgs = [
        'run',
        '-e',
        config.substreamsEndpoint,
        config.substreamsPackage,
        config.substreamsModule,
        '--params',
        normalizedParams,
        '--start-block',
        config.startBlock,
        '--stop-block',
        '0', // Continuous streaming
        '--output',
        'jsonl',
        '--plain-output',
    ];

    // Log the normalized params for debugging
    console.log(`Normalized params: ${normalizedParams}`);
    console.log('');

    // Set environment variable for API token
    const env = { ...process.env, SUBSTREAMS_API_TOKEN: config.apiToken };

    // Spawn substreams process
    const substreams = spawn('substreams', substreamsArgs, {
        env,
        cwd: __dirname,
    });

    // Process stdout line by line
    let buffer = '';
    substreams.stdout.on('data', async (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
            if (line.trim()) {
                await processLine(line);
            }
        }
    });

    // Log stderr
    substreams.stderr.on('data', (data) => {
        console.error('Substreams error:', data.toString());
    });

    // Handle process exit
    substreams.on('close', (code) => {
        console.log('');
        console.log('Substreams closed with code', code);
        console.log('');
        console.log('Statistics:');
        console.log(`  Events received: ${stats.eventsReceived}`);
        console.log(`  Events posted:   ${stats.eventsPosted}`);
        console.log(`  Events failed:   ${stats.eventsFailed}`);
        console.log(`  Retries:         ${stats.retries}`);
        console.log('');

        if (code !== 0) {
            process.exit(code);
        }
    });

    // Handle signals
    process.on('SIGINT', () => {
        console.log('');
        console.log('Shutting down...');
        substreams.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
        console.log('');
        console.log('Shutting down...');
        substreams.kill('SIGTERM');
    });
}

// Run
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
