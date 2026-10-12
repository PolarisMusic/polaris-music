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
 * The opt-in alone is not enough, though, and this guard used to stop there.
 * It says "this is a database I am willing to destroy" — a statement about a
 * habit, not about the database in front of you. Anyone who runs these suites
 * locally has it set permanently, and it then travels unchanged into a shell
 * on the production host, where bolt://127.0.0.1:7687 is the real registry.
 * That nearly happened: a deploy instruction in this project carried the flag
 * and a GRAPH_URI of 127.0.0.1, to be run over ssh on the VPS. It was stopped
 * by an unrelated shell typo, which is not a safety mechanism.
 *
 * So the node count is a second signal, and it is the one the opt-in cannot
 * speak for. A disposable database at the start of a run is empty or holds the
 * leavings of the last one; a registry holds a catalogue. The count was always
 * being read here — it was only ever used to word the refusal. Now it decides.
 *
 * @module test/graphGuard
 */

const OPT_IN = 'ALLOW_DESTRUCTIVE_GRAPH_TESTS';

/**
 * Nodes above which a database stops looking disposable.
 *
 * Generous on purpose: a scratch database left dirty by a previous run holds
 * tens of nodes, and a developer who has imported a release or two to poke at
 * is still well under this. A registry with a real catalogue is orders of
 * magnitude above it. Raise it, deliberately and per-run, with CEILING.
 */
const DEFAULT_MAX_NODES = 2000;

const CEILING = 'ALLOW_DESTRUCTIVE_GRAPH_TESTS_MAX_NODES';

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
    const uri = process.env.GRAPH_URI || '(unset)';
    const optedIn = process.env[OPT_IN] === 'true';

    // Counted whether or not the opt-in is set: without it the number words the
    // refusal, with it the number *is* the check. A database that cannot be
    // counted is refused either way — an unreachable or unreadable target is
    // not a target anyone has established is safe to empty.
    let nodes = null;
    const session = driver.session();
    try {
        const result = await session.run('MATCH (n) RETURN count(n) AS c');
        const count = result.records[0]?.get('c');
        const parsed = typeof count?.toNumber === 'function' ? count.toNumber() : Number(count);
        if (Number.isFinite(parsed)) nodes = parsed;
    } catch {
        // leave nodes null
    } finally {
        try { await session.close(); } catch { /* ignore */ }
    }

    const scale = nodes === null
        ? 'an unknown number of nodes'
        : `${nodes.toLocaleString()} node${nodes === 1 ? '' : 's'}`;

    const tunnelNote =
        `Use bolt://127.0.0.1:7687, never bolt://localhost:7687. An SSH tunnel ` +
        `binds ::1, local Docker binds 127.0.0.1, and "localhost" resolves to ` +
        `::1 first — so with a tunnel open "localhost" silently reaches the ` +
        `remote database instead of your local one.`;

    if (!optedIn) {
        throw new Error(
            `Refusing to run "${suiteName}": this suite deletes every node in the ` +
            `database, and ${OPT_IN} is not set.\n\n` +
            `  Target:  ${uri}\n` +
            `  Contains: ${scale}\n\n` +
            `Point GRAPH_URI at a disposable database and re-run with ` +
            `${OPT_IN}=true.\n\n${tunnelNote}`
        );
    }

    const ceiling = Number.parseInt(process.env[CEILING] ?? '', 10);
    const maxNodes = Number.isFinite(ceiling) && ceiling >= 0 ? ceiling : DEFAULT_MAX_NODES;

    if (nodes === null) {
        throw new Error(
            `Refusing to run "${suiteName}": this suite deletes every node in the ` +
            `database, and the node count could not be read, so there is no ` +
            `evidence this database is disposable.\n\n` +
            `  Target: ${uri}\n\n` +
            `${OPT_IN} says you are willing to destroy a scratch database. It ` +
            `cannot say whether this is one.\n\n${tunnelNote}`
        );
    }

    if (nodes > maxNodes) {
        throw new Error(
            `Refusing to run "${suiteName}": this suite deletes every node in the ` +
            `database, and this one holds ${scale} — far more than a scratch ` +
            `database should.\n\n` +
            `  Target: ${uri}\n\n` +
            `${OPT_IN} is set, but it is a statement about your habits, not ` +
            `about this database. The same flag follows you onto a production ` +
            `host, where bolt://127.0.0.1:7687 is the registry.\n\n` +
            `If this really is disposable, say so for this run and no other:\n` +
            `  ${CEILING}=${nodes} npm run test:graph:ci\n\n${tunnelNote}`
        );
    }
}

export { OPT_IN, CEILING, DEFAULT_MAX_NODES };
