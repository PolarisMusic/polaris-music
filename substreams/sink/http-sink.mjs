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
    substreamsPackage: process.env.SUBSTREAMS_PACKAGE || 'antelope-common@v0.4.0',
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
  SUBSTREAMS_PACKAGE     Substreams package (default: antelope-common@v0.4.0)
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
                `✓ Posted event ${anchoredEvent.content_hash ? anchoredEvent.content_hash.substring(0, 8) : anchoredEvent.event_hash.substring(0, 8)}... ` +
                `(block ${anchoredEvent.block_num}, action: ${anchoredEvent.action_name})`
            );
            stats.eventsPosted++;
            return true;
        } else {
            const errorText = await response.text();
            console.error(
                `✗ Failed to post event ${anchoredEvent.content_hash ? anchoredEvent.content_hash.substring(0, 8) : anchoredEvent.event_hash.substring(0, 8)}...`,
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
                `✗ Timeout posting event ${anchoredEvent.content_hash ? anchoredEvent.content_hash.substring(0, 8) : anchoredEvent.event_hash.substring(0, 8)}... ` +
                `(exceeded ${config.requestTimeoutMs}ms)`
            );
        } else {
            console.error(
                `✗ Network error posting event ${anchoredEvent.content_hash ? anchoredEvent.content_hash.substring(0, 8) : anchoredEvent.event_hash.substring(0, 8)}...:`,
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
 * @param {string} line - JSON line from Substreams output
 */
async function processLine(line) {
    try {
        const data = JSON.parse(line);

        // Extract action traces from filtered_actions module output
        // Format: { "@module": "filtered_actions", "@type": "sf.antelope.type.v1.ActionTraces", "@data": {...} }
        if (data['@module'] === config.substreamsModule && data['@data']) {
            const actionTraces = data['@data'].actionTraces || [];

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
                // Handle three cases: string (needs parsing), object (already parsed), or undefined
                let actionData;
                if (typeof action.jsonData === 'string') {
                    try {
                        actionData = JSON.parse(action.jsonData);
                    } catch (error) {
                        console.warn('  Skipping action with invalid JSON data:', error.message);
                        continue;
                    }
                } else if (typeof action.jsonData === 'object' && action.jsonData !== null) {
                    actionData = action.jsonData;
                } else if (action.data) {
                    // Fallback to raw data if jsonData is not available
                    actionData = action.data;
                } else {
                    console.warn('  Skipping action without parseable data');
                    continue;
                }

                // Ensure we have a content hash (required field)
                if (!actionData.hash) {
                    console.warn('  Skipping action without hash field in payload');
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
 * Check if substreams binary is available
 * @returns {Promise<boolean>} True if available
 */
async function checkSubstreamsBinary() {
    return new Promise((resolve) => {
        const checkProcess = spawn('which', ['substreams']);
        checkProcess.on('close', (code) => {
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
    // Package: antelope-common@v0.4.0 (published by Pinax)
    // Module: filtered_actions (filters by code/action/data predicates)
    // Params: code:CONTRACT_ACCOUNT && action:put
    const substreamsArgs = [
        'run',
        '-e',
        config.substreamsEndpoint,
        config.substreamsPackage,
        config.substreamsModule,
        '--params',
        config.substreamsParams,
        '--start-block',
        config.startBlock,
        '--stop-block',
        '0', // Continuous streaming
        '--output',
        'jsonl',
        '--plain-output',
    ];

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
