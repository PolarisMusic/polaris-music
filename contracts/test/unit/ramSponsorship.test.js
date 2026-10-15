/**
 * @file ramSponsorship.test.js
 * @brief The contract-paid RAM rules, mirrored (no blockchain required)
 *
 * The contract pays for the rows `put()` and `vote()` write. What is capped is
 * how much one account may have *outstanding* — rows held open on its behalf
 * right now — so a submission takes two and gives them back when it is
 * reclaimed. Who pays is a policy; how much you may have in flight is a rate
 * limit; they are separate things and this is where that separation is
 * checked.
 *
 * The contract cannot be executed here — there is no chain and no CDT — so
 * this mirrors ram_payer_for() and ram_release() in JavaScript and tests the
 * arithmetic, as validation.test.js already does for the contract's other pure
 * logic. It is not a substitute for compiling: if the C++ and this file
 * disagree, this file is the one that proves nothing.
 */

const { expect } = require('chai');

const SELF = 'polaris.music';

/** Mirrors the ram_policy table's defaults. */
const defaultPolicy = () => ({
    enabled: true,
    rows_per_account: 30,
    max_total_rows: 3000,
    rows_outstanding: 0,
});

/** Mirrors ram_payer_for(). Mutates the state exactly as it does. */
function ramPayerFor(state, account, rows) {
    const { policy, credits } = state;

    if (!policy.enabled) return account;
    if (policy.rows_outstanding + rows > policy.max_total_rows) return account;

    const open = credits[account] ?? 0;
    if (open + rows > policy.rows_per_account) return account;

    credits[account] = open + rows;
    policy.rows_outstanding += rows;
    return SELF;
}

/** Mirrors ram_release(). Floors at zero, as it does and for the same reason. */
function ramRelease(state, account, rows) {
    const { policy, credits } = state;

    const open = credits[account] ?? 0;
    if (open === 0) return;

    const freed = Math.min(open, rows);
    credits[account] = open - freed;
    policy.rows_outstanding = Math.max(0, policy.rows_outstanding - freed);
}

const newState = (overrides = {}) => ({
    policy: { ...defaultPolicy(), ...overrides },
    credits: {},
    selfPaid: new Set(),
});

/** What put() does: two rows, and a marker when the author pays. */
function submit(state, author, anchorId) {
    const payer = ramPayerFor(state, author, 2);
    if (payer === author) state.selfPaid.add(anchorId);
    return payer;
}

/** What reclaim() does to a submission once its votes are gone. */
function reclaimSubmission(state, author, anchorId) {
    if (state.selfPaid.has(anchorId)) {
        state.selfPaid.delete(anchorId);
        return;
    }
    ramRelease(state, author, 2);
}

const vote = (state, who) => ramPayerFor(state, who, 1);
const clearVote = (state, who) => ramRelease(state, who, 1);

describe('contract-paid RAM', () => {
    describe('a newcomer', () => {
        it('has their first submission paid for by the contract', () => {
            const state = newState();
            expect(submit(state, 'newbie', 1)).to.equal(SELF);
        });

        it('can vote, which is the thing they could not do before', () => {
            // votes.emplace(voter, …) billed the voter, so a zero-RAM account
            // could not vote — the cheaper and far more common action, and the
            // first one anybody takes.
            const state = newState();
            expect(vote(state, 'newbie')).to.equal(SELF);
        });
    });

    describe('the cap is on work in flight, not on a lifetime ration', () => {
        it('comes back when a submission is reclaimed', () => {
            const state = newState({ rows_per_account: 2 });
            expect(submit(state, 'steady', 1)).to.equal(SELF);
            expect(submit(state, 'steady', 2)).to.equal('steady');

            reclaimSubmission(state, 'steady', 1);
            expect(state.credits.steady).to.equal(0);
            expect(submit(state, 'steady', 3)).to.equal(SELF);
        });

        it('lets someone submit forever as long as they settle as they go', () => {
            const state = newState({ rows_per_account: 2 });
            for (let i = 0; i < 50; i++) {
                expect(submit(state, 'patient', i), `submission ${i}`).to.equal(SELF);
                reclaimSubmission(state, 'patient', i);
            }
            expect(state.policy.rows_outstanding).to.equal(0);
        });

        it('stops someone opening fifty at once', () => {
            const state = newState();
            let sponsored = 0;
            for (let i = 0; i < 50; i++) {
                if (submit(state, 'eager', i) === SELF) sponsored++;
            }
            expect(sponsored).to.equal(15);
        });
    });

    describe('an account at its cap may still act, on its own RAM', () => {
        it('pays for the rows itself', () => {
            const state = newState({ rows_per_account: 2 });
            submit(state, 'determined', 1);
            expect(submit(state, 'determined', 2)).to.equal('determined');
        });

        it('is recorded, so reclaim does not credit rows nobody sponsored', () => {
            const state = newState({ rows_per_account: 2 });
            submit(state, 'determined', 1);
            submit(state, 'determined', 2);
            expect(state.selfPaid.has(2)).to.be.true;

            // Reclaiming the self-paid one frees nothing: those rows were never
            // the contract's to give back.
            reclaimSubmission(state, 'determined', 2);
            expect(state.credits.determined).to.equal(2);
            expect(state.policy.rows_outstanding).to.equal(2);

            // Reclaiming the sponsored one does.
            reclaimSubmission(state, 'determined', 1);
            expect(state.credits.determined).to.equal(0);
            expect(state.policy.rows_outstanding).to.equal(0);
        });

        it('closes the farm: self-pay then reclaim does not mint allowance', () => {
            // Without the marker, paying for your own rows and reclaiming them
            // would hand back a slot that was never taken — a one-way
            // conversion of the submitter's RAM into the contract's, repeatable
            // for as long as they cared to.
            const state = newState({ rows_per_account: 2 });
            submit(state, 'farmer', 1);
            const before = state.policy.rows_outstanding;

            for (let i = 2; i < 12; i++) {
                submit(state, 'farmer', i);
                reclaimSubmission(state, 'farmer', i);
            }

            expect(state.policy.rows_outstanding).to.equal(before);
            expect(state.credits.farmer).to.equal(2);
        });
    });

    describe('rows written before any of this existed', () => {
        it('reclaim floors at zero rather than inventing allowance', () => {
            // An anchor from before this change has no marker and was paid for
            // by its author, so reclaiming it looks exactly like reclaiming a
            // sponsored one.
            const state = newState();
            reclaimSubmission(state, 'oldtimer', 999);
            expect(state.credits.oldtimer ?? 0).to.equal(0);
            expect(state.policy.rows_outstanding).to.equal(0);
        });

        it('does not let the global total go negative', () => {
            const state = newState();
            submit(state, 'current', 1);
            reclaimSubmission(state, 'ancient', 998);
            expect(state.policy.rows_outstanding).to.equal(2);
        });
    });

    describe('votes', () => {
        it('free their row when the voter changes their mind', () => {
            const state = newState({ rows_per_account: 1 });
            expect(vote(state, 'fickle')).to.equal(SELF);
            clearVote(state, 'fickle');
            expect(vote(state, 'fickle')).to.equal(SELF);
        });

        it('and when the submission they are on is reclaimed', () => {
            const state = newState({ rows_per_account: 1 });
            vote(state, 'voter');
            expect(state.policy.rows_outstanding).to.equal(1);
            clearVote(state, 'voter');
            expect(state.policy.rows_outstanding).to.equal(0);
        });
    });

    describe('the global ceiling', () => {
        it('stops sponsorship even for an account with room of its own', () => {
            const state = newState({ max_total_rows: 2 });
            expect(submit(state, 'first', 1)).to.equal(SELF);
            expect(submit(state, 'second', 2)).to.equal('second');
            expect(state.credits.second).to.be.undefined;
        });

        it('is checked against the whole request, not one row of it', () => {
            const state = newState({ max_total_rows: 1 });
            expect(submit(state, 'first', 1)).to.equal('first');
            expect(state.policy.rows_outstanding).to.equal(0);
        });

        it('recovers as rows are reclaimed, unlike a lifetime budget', () => {
            // The whole reason the counter measures what is open: otherwise the
            // contract sits on free RAM and refuses to use it because a tally
            // of past generosity says it is spent.
            const state = newState({ max_total_rows: 2 });
            submit(state, 'first', 1);
            expect(submit(state, 'second', 2)).to.equal('second');

            reclaimSubmission(state, 'first', 1);
            expect(submit(state, 'third', 3)).to.equal(SELF);
        });
    });

    describe('the off switch', () => {
        it('bills the account and opens nothing', () => {
            const state = newState({ enabled: false });
            expect(submit(state, 'anyone', 1)).to.equal('anyone');
            expect(state.policy.rows_outstanding).to.equal(0);
            expect(state.credits.anyone).to.be.undefined;
        });

        it('leaves rows already open alone, to come back as they are reclaimed', () => {
            const state = newState();
            submit(state, 'early', 1);
            state.policy.enabled = false;

            expect(state.credits.early).to.equal(2);
            expect(submit(state, 'early', 2)).to.equal('early');

            reclaimSubmission(state, 'early', 1);
            expect(state.policy.rows_outstanding).to.equal(0);
        });
    });

    describe('what it costs, at the measured price', () => {
        // Measured on Jungle4, 2026-10-14: one release submission moved
        // polaristest2's RAM usage by 896 bytes across its anchor and tally, at
        // a spot price of 0.208658 EOS/KiB.
        const BYTES_PER_SUBMISSION = 896;
        const EOS_PER_KIB = 0.208658;
        const bytesToEos = (bytes) => (bytes / 1024) * EOS_PER_KIB;

        it('is about 448 bytes a row', () => {
            expect(BYTES_PER_SUBMISSION / 2).to.equal(448);
        });

        it('is about 13 KiB held open per account at the cap', () => {
            const bytes = defaultPolicy().rows_per_account * (BYTES_PER_SUBMISSION / 2);
            expect(bytes).to.equal(13440);
            expect(bytes / 1024).to.be.closeTo(13.1, 0.1);
        });

        it('is about 274 EOS of RAM the contract must own at the ceiling', () => {
            // Own, not spend: RAM is an asset and sells back. This is the
            // number the ceiling is really set from, and rows are a poor unit
            // to choose it in.
            expect(bytesToEos(defaultPolicy().max_total_rows * 448)).to.be.closeTo(273.9, 1);
            expect(bytesToEos(30 * 448)).to.be.closeTo(2.74, 0.05);
        });
    });
});
