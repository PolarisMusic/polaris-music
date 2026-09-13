/**
 * The sponsored-node lottery: a deterministic, weighted draw for the node the
 * visualization opens on.
 *
 * Nodes with more MUS staked to them win more often; nodes with nothing staked
 * still win sometimes. The draw runs once per period and every visitor in that
 * period sees the same node.
 *
 * The point of this module is that it is a *pure function of published inputs*.
 * Given the seed (a block id) and the stake ledger (the contract's nodeagg
 * table), anyone can recompute the winner and check that the operator did not
 * put their own node on the front page. Everything that could make two
 * implementations disagree is therefore pinned down here rather than left to
 * the caller:
 *
 *   - integers only, all the way down (see `weightOf`)
 *   - one canonical ordering (see `orderCandidates`)
 *   - one canonical reduction of the seed (see `seedToBigInt`)
 *
 * @module api/sponsoredNode
 */

/**
 * MUS is declared as `asset` with 4 decimals in the contract, so on-chain
 * amounts are in ten-thousandths. A whole token is this many units.
 */
export const UNITS_PER_TOKEN = 10000n;

/**
 * Weight every eligible node carries before any stake is counted.
 *
 * This is what gives an unstaked node a chance, and it is the single most
 * consequential number in the design — it sets the exchange rate between
 * tokens and attention. With B as the base weight, N eligible nodes and S
 * tokens staked on one of them, that node wins S/(S + N·B) of the time, so the
 * price of a given win probability scales with the size of the registry. At
 * twelve nodes, ten tokens buys 45%; at ten thousand nodes the same ten tokens
 * buys 0.1%. Raising B makes the long tail louder and sponsorship dearer;
 * lowering it does the reverse.
 *
 * Kept here as a named constant rather than inlined because it is a policy
 * decision, and because moving it on-chain (a `base_weight` in the contract's
 * global state) is the obvious next step if it should ever be governable.
 */
export const DEFAULT_BASE_WEIGHT = 1n;

/**
 * Coerce a stake amount to non-negative integer units.
 *
 * Accepts what the chain and the JSON in front of it actually produce: a
 * bigint, a number, or a string — including the `"12.3456 MUS"` shape an
 * `asset` serializes to. Never parses through a float: `parseFloat` on
 * "0.0003 MUS" and a multiply by 10000 is exactly the kind of rounding that
 * makes one implementation disagree with another about who won.
 *
 * @param {bigint|number|string|null|undefined} amount
 * @returns {bigint} units, clamped at zero
 */
export function toUnits(amount) {
    if (amount == null) return 0n;
    if (typeof amount === 'bigint') return amount > 0n ? amount : 0n;

    if (typeof amount === 'number') {
        if (!Number.isFinite(amount) || amount <= 0) return 0n;
        // Integer units are what the chain stores; a fractional number here is
        // a caller error, and truncating is safer than guessing a scale.
        return BigInt(Math.trunc(amount));
    }

    const text = String(amount).trim();
    if (text === '') return 0n;

    // "12.3456 MUS" — split the symbol off and read the digits as fixed point.
    const assetMatch = text.match(/^(-?\d+)(?:\.(\d+))?\s+[A-Z]{1,7}$/);
    if (assetMatch) {
        const [, whole, frac = ''] = assetMatch;
        if (whole.startsWith('-')) return 0n;
        const padded = (frac + '0000').slice(0, 4);
        return BigInt(whole) * UNITS_PER_TOKEN + BigInt(padded);
    }

    if (/^-?\d+$/.test(text)) {
        const units = BigInt(text);
        return units > 0n ? units : 0n;
    }

    return 0n;
}

/**
 * The weight one candidate carries in the draw: one chunk for existing, plus
 * one for each whole token staked to it.
 *
 * Deliberately floor division on integers. A fractional stake buys nothing
 * until it reaches a whole token, which keeps the weights exactly reproducible
 * and means dust cannot be used to nudge a result.
 *
 * @param {bigint} stakeUnits
 * @param {bigint} [baseWeight]
 * @returns {bigint}
 */
export function weightOf(stakeUnits, baseWeight = DEFAULT_BASE_WEIGHT) {
    return baseWeight + (stakeUnits / UNITS_PER_TOKEN);
}

/**
 * Put the candidates in the one order every implementation must agree on.
 *
 * Ordering matters because the draw assigns each candidate a contiguous slice
 * of the number line: change the order and the same seed picks a different
 * winner. Neo4j does not promise row order without an ORDER BY, so relying on
 * query order would make the result unverifiable and intermittently wrong.
 *
 * The key is the node's on-chain identity — sha256 of its graph id, the same
 * value the contract stakes against — rather than the graph id itself. It is
 * fixed-width, it is what the stake ledger is keyed by, and it does not move
 * if a node is ever renamed.
 *
 * @param {Array<{chainId: string}>} candidates
 * @returns {Array} a new array, ascending by chainId
 */
export function orderCandidates(candidates) {
    return [...candidates].sort((a, b) => {
        const x = String(a.chainId).toLowerCase();
        const y = String(b.chainId).toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
    });
}

/**
 * Read a block id as the draw's random number.
 *
 * @param {string} seedHex - 64 hex characters, no 0x prefix
 * @returns {bigint}
 * @throws {Error} if it is not a 256-bit hex value
 */
export function seedToBigInt(seedHex) {
    const text = String(seedHex ?? '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(text)) {
        throw new Error(`Seed must be 64 hex characters, got: ${JSON.stringify(seedHex)}`);
    }
    return BigInt(`0x${text}`);
}

/**
 * Run the draw.
 *
 * The number line from 0 to the total weight is divided into one contiguous
 * run per candidate, sized by that candidate's weight, in canonical order. The
 * seed, reduced modulo the total, lands in exactly one run.
 *
 * On the modulo: the seed is 256 bits and the total weight will not plausibly
 * exceed a few million, so the bias from the number line not dividing evenly
 * is on the order of 2^-230. It is mentioned only so the next reader does not
 * have to work out whether it was considered.
 *
 * @param {Array<{chainId: string, nodeId?: string, stakeUnits?: bigint|number|string}>} candidates
 * @param {string} seedHex - the seed block's id
 * @param {{baseWeight?: bigint}} [options]
 * @returns {{
 *   winner: object, offset: bigint, totalWeight: bigint,
 *   weights: Array<{chainId: string, weight: bigint, start: bigint, end: bigint}>
 * } | null} null when there is nothing to draw from
 */
export function drawSponsoredNode(candidates, seedHex, options = {}) {
    const baseWeight = options.baseWeight ?? DEFAULT_BASE_WEIGHT;
    if (baseWeight < 0n) throw new Error('baseWeight must not be negative');

    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const ordered = orderCandidates(candidates);

    const weights = [];
    let totalWeight = 0n;
    for (const candidate of ordered) {
        const weight = weightOf(toUnits(candidate.stakeUnits), baseWeight);
        if (weight <= 0n) continue;          // base 0 and nothing staked: not in the draw
        weights.push({
            chainId: candidate.chainId,
            candidate,
            weight,
            start: totalWeight,
            end: totalWeight + weight,
        });
        totalWeight += weight;
    }

    // Only reachable with baseWeight 0 and no stake anywhere, which is a
    // legitimate configuration rather than an error — there is simply no draw.
    if (totalWeight === 0n) return null;

    const offset = seedToBigInt(seedHex) % totalWeight;

    // Linear rather than binary: this runs once per period over a list the
    // size of the registry, and a walk is far easier to check by hand against
    // the published inputs than a bisection is.
    const hit = weights.find((w) => offset >= w.start && offset < w.end);

    return {
        winner: hit.candidate,
        offset,
        totalWeight,
        weights: weights.map(({ chainId, weight, start, end }) => ({ chainId, weight, start, end })),
    };
}
