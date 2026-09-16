/**
 * Balances and per-node stake totals.
 *
 * Two themes. The arithmetic is money arithmetic, so it is integers end to
 * end and the tests go after the places a float would betray it. And the three
 * numbers come from three different sources, so the tests check that one
 * source failing does not take the other two down with it.
 */

import {
    StakeService,
    assetToUnits,
    formatUnits,
    parseSymbol,
} from '../../src/api/stakeService.js';
import { toChainId } from '../../src/api/sponsoredNodeService.js';

const GLOBALS = { token_contract: 'polaristoken', token_symbol: '4,MUS' };

function makeService({
    nodeagg = [], liquid = null, pending = [], accountStakes = null, overrides = {},
} = {}) {
    const calls = { globals: 0, nodeagg: 0, liquid: 0, pending: 0 };

    const chain = {
        contractAccount: 'polarismusic',
        getTableRows: async ({ code, table, scope }) => {
            if (table === 'globals') { calls.globals++; return { rows: [GLOBALS] }; }
            if (table === 'nodeagg') { calls.nodeagg++; return { rows: nodeagg, more: false }; }
            if (table === 'accounts') {
                calls.liquid++;
                if (overrides.liquidThrows) throw new Error('token contract unreachable');
                return { rows: liquid ? [{ balance: liquid }] : [] };
            }
            if (table === 'pendingrwd') {
                calls.pending++;
                if (overrides.pendingThrows) throw new Error('pendingrwd unreachable');
                return { rows: pending };
            }
            return { rows: [] };
        },
    };

    const graph = accountStakes === false ? {} : {
        getAccountStakes: async () => {
            if (overrides.stakesThrow) throw new Error('neo4j down');
            return accountStakes ?? { totalUnits: '0', positions: [] };
        },
    };

    return { service: new StakeService({ graph, chain }), calls };
}

describe('money arithmetic', () => {
    test('units render with the symbol\'s full precision', () => {
        expect(formatUnits(123456n, 4, 'MUS')).toBe('12.3456 MUS');
        expect(formatUnits(0n, 4, 'MUS')).toBe('0.0000 MUS');
    });

    test('a sub-unit amount keeps its leading zeros', () => {
        // 3/10000 of a token. Dividing by 10^4 and formatting the double is
        // where this comes back as "0.0003000000000000001" or worse.
        expect(formatUnits(3n, 4, 'MUS')).toBe('0.0003 MUS');
        expect(formatUnits(30n, 4, 'MUS')).toBe('0.0030 MUS');
    });

    test('a balance past what a double holds exactly is still exact', () => {
        // 2^53 units is where Number stops being able to count by one.
        const huge = 9007199254740993n;      // 2^53 + 1
        expect(formatUnits(huge, 4, 'MUS')).toBe('900719925474.0993 MUS');
    });

    test('round trips through the asset string', () => {
        for (const units of [0n, 1n, 9999n, 10000n, 123456789n]) {
            expect(assetToUnits(formatUnits(units, 4, 'MUS'), 4)).toBe(units);
        }
    });

    test('a whole-number asset scales to the symbol, not to its digits', () => {
        // "7 MUS" at precision 4 is 70000 units, not 7. The chain always
        // renders full precision so this should not arrive, but being wrong by
        // ten thousand about someone's tokens is not a failure mode to leave
        // open.
        expect(assetToUnits('7 MUS', 4)).toBe(70000n);
        expect(assetToUnits('7.0000 MUS', 4)).toBe(70000n);
    });

    test('junk reads as zero rather than NaN', () => {
        expect(assetToUnits(null, 4)).toBe(0n);
        expect(assetToUnits('', 4)).toBe(0n);
        expect(assetToUnits('not an asset', 4)).toBe(0n);
    });

    test('the symbol string is split precision-first', () => {
        expect(parseSymbol('4,MUS')).toEqual({ precision: 4, code: 'MUS' });
        expect(parseSymbol('8,POL')).toEqual({ precision: 8, code: 'POL' });
        expect(parseSymbol(undefined)).toEqual({ precision: 4, code: 'MUS' });
    });
});

describe('stake on a node', () => {
    const NODE = 'polaris:group:alpha';

    test('reports the total and the staker count', async () => {
        const { service } = makeService({
            nodeagg: [{ node_id: toChainId(NODE), total: '42.0000 MUS', staker_count: 3 }],
        });

        const stake = await service.getNodeStake(NODE);
        expect(stake.formatted).toBe('42.0000 MUS');
        expect(stake.units).toBe('420000');
        expect(stake.stakerCount).toBe(3);
        expect(stake.chainId).toBe(toChainId(NODE));
    });

    test('an unstaked node answers zero rather than nothing', async () => {
        // The panel shows this beside every node, so "no row" has to render.
        const { service } = makeService({ nodeagg: [] });

        const stake = await service.getNodeStake(NODE);
        expect(stake.formatted).toBe('0.0000 MUS');
        expect(stake.units).toBe('0');
        expect(stake.stakerCount).toBe(0);
    });

    test('an unreachable chain answers zero rather than throwing', async () => {
        const { service } = makeService();
        service._nodeAggregates = async () => { throw new Error('rpc down'); };

        await expect(service.getNodeStake(NODE)).resolves.toMatchObject({ units: '0' });
    });

    test('the node table is read once for a burst of lookups', async () => {
        // A selection-driven UI asks about several nodes at once; re-reading
        // the whole table per node would turn one click into many RPC calls.
        const { service, calls } = makeService({
            nodeagg: [{ node_id: toChainId(NODE), total: '1.0000 MUS', staker_count: 1 }],
        });

        await service.getNodeStake(NODE);
        await service.getNodeStake('polaris:group:beta');
        await service.getNodeStake('polaris:person:gamma');

        expect(calls.nodeagg).toBe(1);
    });
});

describe('an account balance', () => {
    const ACCOUNT = 'polaristest3';

    test('adds up liquid, staked and pending', async () => {
        const { service } = makeService({
            liquid: '100.0000 MUS',
            pending: [{ amount: '1.5000 MUS' }, { amount: '0.5000 MUS' }],
            accountStakes: {
                totalUnits: '250000',
                positions: [{ nodeId: 'polaris:group:alpha', units: '250000' }],
            },
        });

        const balance = await service.getAccountBalance(ACCOUNT);

        expect(balance.liquid.formatted).toBe('100.0000 MUS');
        expect(balance.staked.formatted).toBe('25.0000 MUS');
        expect(balance.pending.formatted).toBe('2.0000 MUS');
        expect(balance.total.formatted).toBe('127.0000 MUS');
    });

    test('positions carry a readable amount, not just units', async () => {
        const { service } = makeService({
            accountStakes: {
                totalUnits: '250000',
                positions: [{ nodeId: 'polaris:group:alpha', units: '250000' }],
            },
        });

        const { positions } = await service.getAccountBalance(ACCOUNT);
        expect(positions).toHaveLength(1);
        expect(positions[0]).toMatchObject({ nodeId: 'polaris:group:alpha', formatted: '25.0000 MUS' });
    });

    test('an account with nothing reads as zeros, not as an error', async () => {
        const { service } = makeService();
        const balance = await service.getAccountBalance(ACCOUNT);

        expect(balance.liquid.formatted).toBe('0.0000 MUS');
        expect(balance.total.formatted).toBe('0.0000 MUS');
        expect(balance.positions).toEqual([]);
    });

    test('only the MUS row counts, not every token the account holds', async () => {
        const { service } = makeService({ liquid: '5.0000 MUS' });
        const chainRows = service.chain.getTableRows;
        service.chain.getTableRows = async (args) => (args.table === 'accounts'
            ? { rows: [{ balance: '9999.0000 EOS' }, { balance: '5.0000 MUS' }] }
            : chainRows(args));

        const balance = await service.getAccountBalance(ACCOUNT);
        expect(balance.liquid.formatted).toBe('5.0000 MUS');
    });
});

describe('one source failing does not take the others down', () => {
    const ACCOUNT = 'polaristest3';

    test('an unreachable token contract still shows staked and pending', async () => {
        const { service } = makeService({
            overrides: { liquidThrows: true },
            pending: [{ amount: '2.0000 MUS' }],
            accountStakes: { totalUnits: '250000', positions: [] },
        });

        const balance = await service.getAccountBalance(ACCOUNT);
        expect(balance.liquid.formatted).toBe('0.0000 MUS');
        expect(balance.staked.formatted).toBe('25.0000 MUS');
        expect(balance.pending.formatted).toBe('2.0000 MUS');
    });

    test('a failing graph still shows liquid and pending', async () => {
        const { service } = makeService({
            liquid: '10.0000 MUS',
            pending: [{ amount: '1.0000 MUS' }],
            overrides: { stakesThrow: true },
        });

        const balance = await service.getAccountBalance(ACCOUNT);
        expect(balance.liquid.formatted).toBe('10.0000 MUS');
        expect(balance.staked.formatted).toBe('0.0000 MUS');
        expect(balance.total.formatted).toBe('11.0000 MUS');
    });

    test('a graph with no ledger at all is not an error', async () => {
        const { service } = makeService({ liquid: '10.0000 MUS', accountStakes: false });
        await expect(service.getAccountBalance(ACCOUNT)).resolves.toMatchObject({
            staked: { units: '0', formatted: '0.0000 MUS' },
        });
    });
});
