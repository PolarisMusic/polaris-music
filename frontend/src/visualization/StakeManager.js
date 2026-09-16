/**
 * Staking: reading what is staked, and placing a stake.
 *
 * Three jobs, deliberately in one place because they share the amount
 * arithmetic and getting that wrong is getting somebody's tokens wrong:
 *
 *   - how much is staked on the selected node
 *   - what the signed-in account holds (liquid, staked, pending)
 *   - pushing the contract's stake / unstake actions
 *
 * Amounts are handled as integer units and only ever rendered at the edge.
 * A token amount is not a float: 0.1 + 0.2 is not 0.3, and the digit that
 * goes wrong is the one a person is checking.
 *
 * @module visualization/StakeManager
 */

const CONTRACT_ACCOUNT = import.meta.env?.VITE_CONTRACT_ACCOUNT || 'polarismusic';

/**
 * What the token looks like until the chain says otherwise.
 *
 * The contract declares its symbol in its globals row, and every stake read carries
 * that declaration back. These are the shape to assume before the first read
 * lands, not the authority: a bundle built today must not decide the precision
 * of a symbol the contract can change.
 */
export const TOKEN_PRECISION = 4;
export const TOKEN_SYMBOL = 'MUS';

/**
 * Turn what a person typed into the asset string the contract expects.
 *
 * Parsed as text rather than through parseFloat: "0.1" as a double is
 * 0.1000000000000000055, and multiplying that by 10^4 is how a stake becomes
 * one unit short of what was typed.
 *
 * @param {string} input
 * @param {{precision?: number, symbol?: string}} [token] - as the chain declares it
 * @returns {{units: bigint, asset: string}}
 * @throws {Error} when it is not a positive amount the symbol can hold
 */
export function parseAmount(input, { precision = TOKEN_PRECISION, symbol = TOKEN_SYMBOL } = {}) {
    const text = String(input ?? '').trim();
    const match = text.match(/^(\d+)(?:\.(\d*))?$/);
    if (!match) throw new Error('Enter an amount like 10 or 10.5');

    const [, whole, frac = ''] = match;
    if (frac.length > precision) {
        throw new Error(`${symbol} holds at most ${precision} decimal places`);
    }

    const padded = frac.padEnd(precision, '0');
    const units = BigInt(whole) * (10n ** BigInt(precision)) + BigInt(padded || '0');
    if (units <= 0n) throw new Error('Amount must be greater than zero');

    // A zero-precision symbol takes no decimal point at all; "5. TOK" is not
    // an asset the chain will unpack.
    return { units, asset: `${padded ? `${whole}.${padded}` : whole} ${symbol}` };
}

/**
 * Render integer units for display. String surgery, never division.
 *
 * @param {bigint|string|number} units
 * @param {{precision?: number, symbol?: string}} [token]
 * @returns {string}
 */
export function formatUnits(units, { precision = TOKEN_PRECISION, symbol = TOKEN_SYMBOL } = {}) {
    const value = BigInt(units ?? 0);
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(precision + 1, '0');
    const whole = digits.slice(0, digits.length - precision) || '0';
    const frac = precision ? `.${digits.slice(digits.length - precision)}` : '';
    return `${negative ? '-' : ''}${whole}${frac} ${symbol}`;
}

export class StakeManager {
    /**
     * @param {object} deps
     * @param {object} deps.api - GraphAPI, for its baseUrl
     * @param {object} deps.walletManager
     */
    constructor({ api, walletManager }) {
        this.api = api;
        this.walletManager = walletManager;
        this._nodeStakeCache = new Map();
        // Replaced by whatever the first stake read reports the chain declares.
        this.token = { precision: TOKEN_PRECISION, symbol: TOKEN_SYMBOL };
    }

    /** @private */
    get baseUrl() {
        return this.api?.baseUrl || '/api';
    }

    /**
     * How much is staked on a node.
     *
     * Never throws: this decorates a panel that has to render regardless, so
     * an unreachable backend shows nothing rather than an error where the
     * node's details should be.
     *
     * @param {string} nodeId
     * @param {{refresh?: boolean}} [options]
     * @returns {Promise<{units: string, formatted: string, stakerCount: number}|null>}
     */
    async getNodeStake(nodeId, { refresh = false } = {}) {
        if (!nodeId) return null;
        if (!refresh && this._nodeStakeCache.has(nodeId)) return this._nodeStakeCache.get(nodeId);

        try {
            const response = await fetch(`${this.baseUrl}/stake/node/${encodeURIComponent(nodeId)}`);
            if (!response.ok) return null;

            const data = await response.json();
            if (!data?.success) return null;

            if (Number.isInteger(data.precision) && data.symbol) {
                this.token = { precision: data.precision, symbol: data.symbol };
            }

            const stake = {
                units: data.units,
                formatted: data.formatted,
                stakerCount: data.stakerCount,
            };
            this._nodeStakeCache.set(nodeId, stake);
            return stake;
        } catch (error) {
            console.warn('Node stake unavailable:', error.message);
            return null;
        }
    }

    /**
     * The signed-in account's balance, or null when nobody is signed in.
     *
     * @returns {Promise<object|null>}
     */
    async getBalance() {
        const account = this.accountName();
        if (!account) return null;

        try {
            const response = await fetch(`${this.baseUrl}/stake/account/${encodeURIComponent(account)}`);
            if (!response.ok) return null;

            const data = await response.json();
            return data?.success ? data : null;
        } catch (error) {
            console.warn('Balance unavailable:', error.message);
            return null;
        }
    }

    /**
     * The one-line balance for the top bar: liquid, staked, and claimable
     * only when there is something to claim — a "0.0000 MUS claimable" in the
     * chrome reads as a broken reward rather than an empty one.
     *
     * Empty string whenever there is nothing to say, including every failure:
     * a balance is a nicety beside the graph and must not put an error in the
     * chrome of a page that is otherwise working.
     *
     * @returns {Promise<string>}
     */
    async balanceSummary() {
        const balance = await this.getBalance();
        if (!balance) return '';

        const pending = BigInt(balance.pending?.units ?? 0) > 0n
            ? ` · ${balance.pending.formatted} claimable`
            : '';
        return `${balance.liquid.formatted} · ${balance.staked.formatted} staked${pending}`;
    }

    /**
     * Write that summary into an element, or clear it.
     *
     * @param {HTMLElement|null} element
     * @returns {Promise<void>}
     */
    async refreshBalanceInto(element) {
        if (!element) return;
        try {
            element.textContent = await this.balanceSummary();
        } catch (error) {
            console.warn('Balance unavailable:', error.message);
            element.textContent = '';
        }
    }

    /** @returns {string|null} */
    accountName() {
        if (!this.walletManager?.isConnected?.()) return null;
        return this.walletManager.getSession?.()?.actor?.toString?.() ?? null;
    }

    /**
     * Place or remove a stake.
     *
     * The node id is hashed to the checksum256 the contract keys by, the same
     * derivation likes use — the two must agree or the stake lands under an
     * identity nothing reads.
     *
     * @param {'stake'|'unstake'} action
     * @param {string} nodeId
     * @param {string} amountInput - as typed
     * @returns {Promise<{transactionId: string, asset: string}>}
     */
    async submit(action, nodeId, amountInput) {
        if (action !== 'stake' && action !== 'unstake') {
            throw new Error(`Unknown action ${action}`);
        }
        if (!this.walletManager?.isConnected?.()) {
            throw new Error('Connect a wallet first');
        }

        const { asset } = parseAmount(amountInput, this.token);
        const nodeHash = await this.nodeIdToChecksum256(nodeId);
        const session = this.walletManager.getSession();
        const actor = session.actor.toString();

        const result = await this.walletManager.transact({
            actions: [{
                account: CONTRACT_ACCOUNT,
                name: action,
                authorization: [{ actor: session.actor, permission: session.permission }],
                data: { account: actor, node_id: nodeHash, quantity: asset },
            }],
        });

        // The panel's figure is stale the moment this lands, and the chain
        // read behind it is cached server-side, so drop ours rather than show
        // a number the visitor just changed.
        this._nodeStakeCache.delete(nodeId);

        return { transactionId: result?.response?.transaction_id ?? '', asset };
    }

    /**
     * The contract's identity for a node: sha256 of the graph id, unless the
     * id already is one.
     *
     * @param {string} nodeId
     * @returns {Promise<string>}
     */
    async nodeIdToChecksum256(nodeId) {
        const text = String(nodeId);
        if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();

        const data = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }
}
