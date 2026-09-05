#!/usr/bin/env node
/**
 * @fileoverview Measure what a submission actually costs an account in RAM.
 *
 * The business model — paid account creation and submission, covering RAM plus
 * margin — needs a real number under it, and the contract makes the submitter
 * pay: put() emplaces into `anchors` and `tallies` with `author` as the payer
 * (polaris.music.cpp, "ANCHOR" and "Initialize zeroed tally row"), so a new
 * user needs RAM of their own before their first release.
 *
 * That cost is not a constant and cannot be read off the struct. The anchor row
 * is variable width: fixed fields plus a `std::string event_cid` holding an
 * IPFS CIDv1 and a `std::vector<name> tags`. A release with five tags costs
 * more than one with none. So measure it against a real submission rather than
 * quoting a figure.
 *
 * Usage:
 *
 *   # One-off reading for one or more accounts
 *   node scripts/measureRam.js polaristest2 polaristest3
 *
 *   # Watch mode: prints a line every time usage changes. Start this, then
 *   # submit a release in the browser, and read the delta it prints.
 *   node scripts/measureRam.js polaristest2 --watch
 *
 * Environment:
 *   RPC_URL   — chain API endpoint (default https://jungle4.greymass.com)
 *
 * Nothing here signs anything: it only reads /v1/chain/get_account and the
 * eosio.rammarket table.
 */

const rpcUrl = (process.env.RPC_URL || 'https://jungle4.greymass.com').replace(/\/+$/, '');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const intervalMs = Number(
    (args.find(a => a.startsWith('--interval=')) || '').split('=')[1] || 2000
);
const accounts = args.filter(a => !a.startsWith('--'));

if (accounts.length === 0) {
    console.error('Usage: node scripts/measureRam.js <account> [account...] [--watch] [--interval=ms]');
    process.exit(1);
}

/**
 * POST a chain API call.
 *
 * @param {string} path - e.g. '/v1/chain/get_account'
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function rpc(path, body) {
    const res = await fetch(`${rpcUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
}

/**
 * Current RAM usage and quota for an account, in bytes.
 *
 * @param {string} account
 * @returns {Promise<{usage: number, quota: number}>}
 */
async function ramOf(account) {
    const info = await rpc('/v1/chain/get_account', { account_name: account });
    return { usage: Number(info.ram_usage), quota: Number(info.ram_quota) };
}

/**
 * Spot price of RAM from the eosio.rammarket Bancor pool.
 *
 * Returned as system-token units per byte. This is the marginal price and
 * ignores the 0.5% buy/sell fee, so treat it as a floor when pricing.
 *
 * @returns {Promise<{pricePerByte: number, symbol: string}|null>}
 */
async function ramPrice() {
    try {
        const res = await rpc('/v1/chain/get_table_rows', {
            json: true, code: 'eosio', scope: 'eosio', table: 'rammarket', limit: 1
        });
        const row = res.rows && res.rows[0];
        if (!row) return null;

        const [quoteAmount, symbol] = String(row.quote.balance).split(' ');
        const [baseAmount] = String(row.base.balance).split(' ');
        const bytes = Number(baseAmount);
        const tokens = Number(quoteAmount);
        if (!bytes || !tokens) return null;

        return { pricePerByte: tokens / bytes, symbol };
    } catch {
        // Pricing is a nicety; a missing rammarket must not stop the measurement.
        return null;
    }
}

const fmtBytes = (n) => `${n.toLocaleString()} B (${(n / 1024).toFixed(2)} KiB)`;

async function snapshot() {
    const out = new Map();
    for (const account of accounts) {
        try {
            out.set(account, await ramOf(account));
        } catch (error) {
            console.error(`  ${account}: ${error.message}`);
        }
    }
    return out;
}

async function main() {
    const price = await ramPrice();

    const first = await snapshot();
    console.log(`RAM on ${rpcUrl}`);
    for (const [account, { usage, quota }] of first) {
        const free = quota - usage;
        console.log(`  ${account}: using ${fmtBytes(usage)} of ${fmtBytes(quota)} — ${fmtBytes(free)} free`);
    }
    if (price) {
        console.log(`  RAM spot price: ${(price.pricePerByte * 1024).toFixed(6)} ${price.symbol}/KiB ` +
                    '(marginal, excludes the 0.5% fee)');
    }

    if (!watch) return;

    console.log(`\nWatching every ${intervalMs}ms. Submit a release now; deltas print below.`);
    console.log('Press Ctrl-C to stop.\n');

    let previous = first;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        await new Promise(r => setTimeout(r, intervalMs));
        const now = await snapshot();
        for (const [account, current] of now) {
            const before = previous.get(account);
            if (!before || before.usage === current.usage) continue;

            const delta = current.usage - before.usage;
            const sign = delta > 0 ? '+' : '';
            let line = `${new Date().toISOString()}  ${account}  ${sign}${delta} B ` +
                       `(now ${fmtBytes(current.usage)}, ${fmtBytes(current.quota - current.usage)} free)`;
            if (price && delta > 0) {
                line += `  ≈ ${(delta * price.pricePerByte).toFixed(4)} ${price.symbol}`;
            }
            console.log(line);
        }
        previous = now;
    }
}

main().catch((error) => {
    console.error(`measureRam failed: ${error.message}`);
    process.exit(1);
});
