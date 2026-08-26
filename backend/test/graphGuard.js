/**
 * @fileoverview Safety guard for test suites that wipe the whole graph
 *
 * Several integration suites run `MATCH (n) DETACH DELETE n` in beforeAll and
 * again in beforeEach. That is correct against a disposable database and
 * catastrophic against anything else.
 *
 * The failure mode is not hypothetical. The deployment runbook documents an
 * SSH tunnel for inspecting production Neo4j:
 *
 *     ssh -L 7687:localhost:7687 polaris@polaris.mu
 *
 * With that open, `bolt://localhost:7687` reaches production. Worse, ssh binds
 * the forward on `::1` while local Docker publishes on `127.0.0.1`, and since
 * Node 17 `dns.lookup` no longer reorders results to IPv4-first — so on macOS
 * `localhost` resolves to `::1` and *prefers the tunnel*. A developer following
 * the documented instructions gets production without any indication of it.
 *
 * Because a tunnel makes a remote database indistinguishable from a local one
 * at the socket level, no amount of URI, host, or port inspection can tell them
 * apart. The only signal network topology cannot fake is an explicit opt-in, so
 * that is what this guard requires.
 *
 * @module test/graphGuard
 */

const OPT_IN = 'ALLOW_DESTRUCTIVE_GRAPH_TESTS';

/**
 * Refuse to proceed unless the caller has explicitly opted in to destroying
 * whatever database GRAPH_URI points at.
 *
 * Call this at the top of `beforeAll`, before the first DETACH DELETE.
 *
 * @param {import('neo4j-driver').Driver} driver - Connected Neo4j driver
 * @param {string} suiteName - Suite name, for the refusal message
 * @throws {Error} when the opt-in is absent
 */
export async function assertDisposableGraph(driver, suiteName) {
    if (process.env[OPT_IN] === 'true') return;

    const uri = process.env.GRAPH_URI || '(unset)';

    // Best effort: naming the node count makes the refusal concrete rather than
    // procedural. A database that cannot even be counted is still refused.
    let scale = 'an unknown number of nodes';
    const session = driver.session();
    try {
        const result = await session.run('MATCH (n) RETURN count(n) AS c');
        const count = result.records[0]?.get('c');
        const nodes = typeof count?.toNumber === 'function' ? count.toNumber() : Number(count);
        if (Number.isFinite(nodes)) {
            scale = `${nodes.toLocaleString()} node${nodes === 1 ? '' : 's'}`;
        }
    } catch {
        // fall through with the unknown-count wording
    } finally {
        try { await session.close(); } catch { /* ignore */ }
    }

    throw new Error(
        `Refusing to run "${suiteName}": this suite deletes every node in the ` +
        `database, and ${OPT_IN} is not set.\n\n` +
        `  Target:  ${uri}\n` +
        `  Contains: ${scale}\n\n` +
        `Point GRAPH_URI at a disposable database and re-run with ` +
        `${OPT_IN}=true.\n\n` +
        `Use bolt://127.0.0.1:7687, never bolt://localhost:7687. An SSH tunnel ` +
        `binds ::1, local Docker binds 127.0.0.1, and "localhost" resolves to ` +
        `::1 first — so with a tunnel open "localhost" silently reaches the ` +
        `remote database instead of your local one.`
    );
}

export { OPT_IN };
