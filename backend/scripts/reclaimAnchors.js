#!/usr/bin/env node
/**
 * @fileoverview Free the on-chain RAM of settled curation operations.
 *
 * Every finalized anchor still holds its vote rows, its tally and itself —
 * roughly 461, 336 and 552 bytes, billed to voters and to authors. The contract
 * has shipped reclaim() to release them since it was added, and nothing has
 * ever called it.
 *
 * Usage:
 *
 *   node --env-file=.env scripts/reclaimAnchors.js              # dry run
 *   node --env-file=.env scripts/reclaimAnchors.js --execute    # signs
 *
 * Dry run is the default deliberately: this deletes on-chain state and cannot
 * be undone. Read the plan before handing it a key.
 *
 * Environment:
 *   RPC_URL, CONTRACT_ACCOUNT          — chain to act on
 *   RECLAIM_SIGNER_PRIVATE_KEY         — required only with --execute
 *   RECLAIM_SIGNER_ACCOUNT             — defaults to CONTRACT_ACCOUNT
 *   GRAPH_URI / GRAPH_USER / GRAPH_PASSWORD — for the tally snapshot
 */

import { Api, JsonRpc } from 'eosjs';
import { JsSignatureProvider } from 'eosjs/dist/eosjs-jssig.js';
import { TextEncoder, TextDecoder } from 'util';
import { reclaimSettledAnchors } from '../src/chain/reclaimService.js';
import MusicGraphDatabase from '../src/graph/schema.js';

const execute = process.argv.includes('--execute');
const rpcUrl = process.env.RPC_URL || 'https://jungle4.greymass.com';
const contract = process.env.CONTRACT_ACCOUNT || 'polarismusic';
const signer = process.env.RECLAIM_SIGNER_ACCOUNT || contract;

const rpc = new JsonRpc(rpcUrl, { fetch });

/**
 * Read every row of a contract table, following pagination.
 *
 * @param {Object} query
 * @returns {Promise<Object[]>}
 */
async function allRows(query) {
    const rows = [];
    let lower;
    for (;;) {
        const page = await rpc.get_table_rows({
            json: true, limit: 100, ...query, lower_bound: lower
        });
        rows.push(...page.rows);
        if (!page.more || !page.next_key) return rows;
        lower = page.next_key;
    }
}

function makeChain(api) {
    const push = async (name, data) => api.transact(
        { actions: [{ account: contract, name, authorization: [{ actor: signer, permission: 'active' }], data }] },
        { blocksBehind: 3, expireSeconds: 30 }
    );

    return {
        getAnchors: () => allRows({ code: contract, scope: contract, table: 'anchors' }),

        async getAnchor(hash) {
            const page = await rpc.get_table_rows({
                json: true, code: contract, scope: contract, table: 'anchors',
                index_position: 2, key_type: 'sha256',
                lower_bound: hash, upper_bound: hash, limit: 1
            });
            return page.rows[0] ?? null;
        },

        async getTally(anchorId) {
            const page = await rpc.get_table_rows({
                json: true, code: contract, scope: contract, table: 'votetally',
                lower_bound: anchorId, upper_bound: anchorId, limit: 1
            });
            return page.rows[0] ?? null;
        },

        finalize: (hash) => push('finalize', { tx_hash: hash }),
        reclaim: (hash, maxRows) => push('reclaim', { tx_hash: hash, max_rows: maxRows }),
    };
}

async function main() {
    let api = null;
    let graph = null;

    if (execute) {
        const key = process.env.RECLAIM_SIGNER_PRIVATE_KEY;
        if (!key) {
            console.error('RECLAIM_SIGNER_PRIVATE_KEY is required with --execute.');
            process.exit(1);
        }
        api = new Api({
            rpc,
            signatureProvider: new JsSignatureProvider([key]),
            textDecoder: new TextDecoder(),
            textEncoder: new TextEncoder(),
        });
        // Optional: without it the reclaim still frees the RAM, it just loses
        // the tally that the chain is about to erase.
        try {
            graph = new MusicGraphDatabase(process.env);
        } catch (error) {
            console.warn(`Graph unavailable, tallies will not be snapshotted: ${error.message}`);
        }
    }

    console.log(`${execute ? 'Reclaiming' : 'DRY RUN against'} ${contract} via ${rpcUrl}`);

    const result = await reclaimSettledAnchors({
        chain: makeChain(api),
        graph,
        execute,
        log: (msg, data) => console.log(`  ${msg}`, data ?? ''),
    });

    console.log(`\nfinalized ${result.finalized.length}, reclaimed ${result.reclaimed.length}, ` +
                `waiting ${result.waiting}, failed ${result.failed.length}, ` +
                `${result.calls} transaction(s)`);
    for (const f of result.failed) {
        console.error(`  FAILED ${f.stage} ${f.hash.slice(0, 12)}: ${f.error}`);
    }

    if (!execute && (result.finalized.length || result.reclaimed.length)) {
        console.log('\nRe-run with --execute to actually do this.');
    }

    await graph?.close?.();
    process.exit(result.failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error('Reclaim run failed:', error.message);
    process.exit(1);
});
