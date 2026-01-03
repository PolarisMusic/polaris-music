#!/usr/bin/env node
/**
 * @fileoverview HTTP Sink for Polaris Substreams
 *
 * Consumes anchored events from Substreams and posts them to the backend ingestion endpoint.
 * Implements retry logic with exponential backoff for resilience.
 *
 * Usage:
 *   node http-sink.js --endpoint=http://localhost:3000 --contract=polaris
 *
 * Environment Variables:
 *   BACKEND_URL         - Backend ingestion endpoint (default: http://localhost:3000)
 *   SUBSTREAMS_ENDPOINT - Firehose endpoint (default: eos.firehose.pinax.network:443)
 *   SUBSTREAMS_API_TOKEN - Pinax API token (required)
 *   START_BLOCK         - Starting block number (default: latest - 1000)
 *   CONTRACT_ACCOUNT    - Contract account name (default: polaris)
 */

import { spawn } from 'child_process';
import fetch from 'node-fetch';

// Configuration
const config = {
    backendUrl: process.env.BACKEND_URL || 'http://localhost:3000',
    substreamsEndpoint: process.env.SUBSTREAMS_ENDPOINT || 'eos.firehose.pinax.network:443',
    apiToken: process.env.SUBSTREAMS_API_TOKEN || '',
    startBlock: process.env.START_BLOCK || '0',
    contractAccount: process.env.CONTRACT_ACCOUNT || 'polaris',
    maxRetries: 5,
    retryDelayMs: 1000,
};

// Parse command-line arguments
for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--endpoint=')) {
        config.backendUrl = arg.split('=')[1];
    } else if (arg.startsWith('--contract=')) {
        config.contractAccount = arg.split('=')[1];
    } else if (arg.startsWith('--start-block=')) {
        config.startBlock = arg.split('=')[1];
    }
}

// Validation
if (!config.apiToken) {
    console.error('ERROR: SUBSTREAMS_API_TOKEN environment variable is required');
    console.error('Get your API key from https://app.pinax.network');
    process.exit(1);
}

console.log('Polaris Substreams HTTP Sink');
console.log('============================');
console.log(`Backend URL:        ${config.backendUrl}`);
console.log(`Substreams Endpoint: ${config.substreamsEndpoint}`);
console.log(`Contract Account:   ${config.contractAccount}`);
console.log(`Start Block:        ${config.startBlock}`);
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
 * @param {Object} anchoredEvent - AnchoredEvent protobuf object
 * @param {number} attempt - Current retry attempt (1-indexed)
 * @returns {Promise<boolean>} Success status
 */
async function postAnchoredEvent(anchoredEvent, attempt = 1) {
    try {
        const response = await fetch(`${config.backendUrl}/api/ingest/anchored-event`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(anchoredEvent),
            timeout: 10000, // 10 second timeout
        });

        if (response.ok) {
            const result = await response.json();
            console.log(
                `✓ Posted event ${anchoredEvent.event_hash.substring(0, 8)}... ` +
                `(block ${anchoredEvent.block_num}, action: ${anchoredEvent.action_name})`
            );
            stats.eventsPosted++;
            return true;
        } else {
            const errorText = await response.text();
            console.error(
                `✗ Failed to post event ${anchoredEvent.event_hash.substring(0, 8)}...`,
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
        console.error(
            `✗ Network error posting event ${anchoredEvent.event_hash.substring(0, 8)}...:`,
            error.message
        );

        // Retry on network errors
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

        // Extract anchored events from Substreams output
        // Format: { "@module": "map_anchored_events", "@type": "...", "@data": {...} }
        if (data['@module'] === 'map_anchored_events' && data['@data']) {
            const anchoredEvents = data['@data'].events || [];

            for (const event of anchoredEvents) {
                stats.eventsReceived++;

                // Convert protobuf bytes to objects for posting
                const postableEvent = {
                    event_hash: event.event_hash || event.eventHash,
                    payload: event.payload ? Buffer.from(event.payload, 'base64').toString('utf-8') : '',
                    block_num: event.block_num || event.blockNum,
                    block_id: event.block_id || event.blockId,
                    trx_id: event.trx_id || event.trxId,
                    action_ordinal: event.action_ordinal || event.actionOrdinal,
                    timestamp: event.timestamp,
                    source: event.source,
                    contract_account: event.contract_account || event.contractAccount,
                    action_name: event.action_name || event.actionName,
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
 * Main function: Run Substreams and pipe output to HTTP sink
 */
async function main() {
    console.log('Starting Substreams...');
    console.log('');

    // Build substreams command
    const substreamsArgs = [
        'run',
        '-e',
        config.substreamsEndpoint,
        '--manifest',
        '../substreams.yaml',
        'map_anchored_events',
        '-p',
        `map_anchored_events=${config.contractAccount}`,
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
