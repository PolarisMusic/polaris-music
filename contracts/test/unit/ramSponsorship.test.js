/**
 * @file ramSponsorship.test.js
 * @brief The contract-paid RAM allowance, mirrored (no blockchain required)
 *
 * `ram_payer_for()` decides, for every row `put()` and `vote()` are about to
 * write, whether the contract buys the RAM or the submitter does. It is a
 * handful of comparisons, and all of them are load-bearing: get one wrong and
 * either newcomers cannot take part at all, or the contract's RAM drains
 * without a floor.
 *
 * The contract cannot be executed here — there is no chain and no CDT — so
 * this mirrors the helper in JavaScript and tests the arithmetic. That is the
 * same arrangement validation.test.js already uses for the parts of the
 * contract that are pure logic. It is not a substitute for compiling: if the
 * C++ and this file disagree, this file is the one that proves nothing.
 */

const { expect } = require('chai');

const SELF = 'polaris.music';

/** Mirrors the ram_policy table's defaults. */
const defaultPolicy = () => ({
    enabled: true,
    rows_per_account: 30,
    max_total_rows: 3000,
    rows_sponsored: 0,
});

/** Mirrors ram_payer_for(). Mutates policy and credits exactly as it does. */
function ramPayerFor(state, account, rows) {
    const { policy, credits } = state;

    if (!policy.enabled) return account;
    if (policy.rows_sponsored + rows > policy.max_total_rows) return account;

    const used = credits[account] ?? 0;
    if (used + rows > policy.rows_per_account) return account;

    credits[account] = used + rows;
    policy.rows_sponsored += rows;
    return SELF;
}

const newState = (overrides = {}) => ({
    policy: { ...defaultPolicy(), ...overrides },
    credits: {},
});

/** What put() and vote() ask for. */
const submit = (state, who) => ramPayerFor(state, who, 2);
const vote = (state, who) => ramPayerFor(state, who, 1);

describe('contract-paid RAM allowance', () => {
    describe('a newcomer', () => {
        it('has their first submission paid for by the contract', () => {
            const state = newState();
            expect(submit(state, 'newbie')).to.equal(SELF);
        });

        it('can vote, which is the thing they could not do before', () => {
            // votes.emplace(voter, …) billed the voter, so a zero-RAM account
            // could not vote — the cheaper and far more common action, and the
            // first one anybody takes.
            const state = newState();
            expect(vote(state, 'newbie')).to.equal(SELF);
        });
    });

    describe('the allowance runs out', () => {
        it('covers exactly ten submissions and ten votes at the default', () => {
            const state = newState();
            for (let i = 0; i < 10; i++) {
                expect(submit(state, 'heavy'), `submission ${i + 1}`).to.equal(SELF);
            }
            for (let i = 0; i < 10; i++) {
                expect(vote(state, 'heavy'), `vote ${i + 1}`).to.equal(SELF);
            }
            expect(state.credits.heavy).to.equal(30);
        });

        it('hands the next row to the account itself', () => {
            const state = newState({ rows_per_account: 2 });
            expect(submit(state, 'heavy')).to.equal(SELF);
            expect(submit(state, 'heavy')).to.equal('heavy');
        });

        it('does not reset — the credit outlives the allowance', () => {
            // Erasing an exhausted credit row would reclaim a few bytes and
            // hand out a fresh allowance with them.
            const state = newState({ rows_per_account: 2 });
            submit(state, 'heavy');
            submit(state, 'heavy');
            submit(state, 'heavy');
            expect(state.credits.heavy).to.equal(2);
            expect(submit(state, 'heavy')).to.equal('heavy');
        });
    });

    describe('a submission is two rows or none', () => {
        it('is paid by the account when only one row of allowance is left', () => {
            const state = newState({ rows_per_account: 3 });
            expect(submit(state, 'odd')).to.equal(SELF);
            expect(submit(state, 'odd')).to.equal('odd');
        });

        it('leaves that last row unspent, so a vote can still use it', () => {
            // The anchor and its tally are written together. Sponsoring one
            // and not the other would stand a submission half-written against
            // an author with no RAM for the rest.
            const state = newState({ rows_per_account: 3 });
            submit(state, 'odd');
            submit(state, 'odd');
            expect(state.credits.odd).to.equal(2);
            expect(vote(state, 'odd')).to.equal(SELF);
            expect(state.credits.odd).to.equal(3);
        });
    });

    describe('the global ceiling', () => {
        it('stops sponsorship even for an account with allowance left', () => {
            const state = newState({ max_total_rows: 2 });
            expect(submit(state, 'first')).to.equal(SELF);
            expect(submit(state, 'second')).to.equal('second');
            expect(state.credits.second).to.be.undefined;
        });

        it('is checked against the whole request, not one row of it', () => {
            const state = newState({ max_total_rows: 1 });
            expect(submit(state, 'first')).to.equal('first');
            expect(state.policy.rows_sponsored).to.equal(0);
        });

        it('still allows a request that exactly reaches it', () => {
            const state = newState({ max_total_rows: 2 });
            expect(submit(state, 'first')).to.equal(SELF);
            expect(state.policy.rows_sponsored).to.equal(2);
        });
    });

    describe('the off switch', () => {
        it('bills the account and consumes nothing', () => {
            const state = newState({ enabled: false });
            expect(submit(state, 'anyone')).to.equal('anyone');
            expect(state.policy.rows_sponsored).to.equal(0);
            expect(state.credits.anyone).to.be.undefined;
        });

        it('does not disturb allowance already spent', () => {
            // Winding sponsorship down stops new grants; it does not claw back
            // rows that exist and are in use.
            const state = newState();
            submit(state, 'early');
            state.policy.enabled = false;
            expect(state.credits.early).to.equal(2);
            expect(submit(state, 'early')).to.equal('early');
            expect(state.credits.early).to.equal(2);
        });
    });

    describe('what it costs, at the measured price', () => {
        // Measured on Jungle4, 2026-10-14: one release submission moved
        // polaristest2's RAM usage by 896 bytes across its anchor and tally,
        // at a spot price of 0.208658 EOS/KiB.
        const BYTES_PER_SUBMISSION = 896;
        const EOS_PER_KIB = 0.208658;

        it('is about 448 bytes a row', () => {
            expect(BYTES_PER_SUBMISSION / 2).to.equal(448);
        });

        it('is about 13 KiB for one account at the default allowance', () => {
            const bytes = (defaultPolicy().rows_per_account) * (BYTES_PER_SUBMISSION / 2);
            expect(bytes).to.equal(13440);
            expect(bytes / 1024).to.be.closeTo(13.1, 0.1);
        });

        it('is about 2.7 EOS an account, and 273 at the default ceiling', () => {
            // The ceiling is the bill. Worth seeing in the same units it is
            // paid in before setting it from a round number of rows.
            const perAccount = (30 * 448 / 1024) * EOS_PER_KIB;
            const atCeiling = (3000 * 448 / 1024) * EOS_PER_KIB;
            expect(perAccount).to.be.closeTo(2.74, 0.05);
            expect(atCeiling).to.be.closeTo(273.9, 1);
        });
    });
});
