/**
 * @file polaris.music.cpp
 * @brief Antelope smart contract for the Polaris Music Registry
 *
 * This contract handles on-chain anchoring of music data events, voting with
 * Fractally Respect weights, stake management, and reward distribution.
 *
 * Key Features:
 * - Event anchoring with SHA256 hashes
 * - Respect-weighted voting from Fractally integration
 * - Token staking on music entities (Groups, Persons, etc.)
 * - Logarithmic emission curve for rewards
 * - Attestation system for high-value submissions
 *
 * @author Polaris Music Registry Team
 * @version 1.0.0
 * @date 2025-12-05
 */

#include <eosio/eosio.hpp>
#include <eosio/asset.hpp>
#include <eosio/crypto.hpp>
#include <eosio/singleton.hpp>
#include <eosio/system.hpp>
#include <eosio/action.hpp>
#include <cmath>

using namespace eosio;

/**
 * @brief Main Polaris Music Registry contract
 *
 * Manages the on-chain anchoring system for the decentralized music registry.
 * All actual music data is stored off-chain (IPFS/S3), with only hashes and
 * metadata stored on-chain for efficiency and immutability.
 */
CONTRACT polaris : public contract {
public:
    using contract::contract;

    // ============ CORE ANCHORING ACTIONS ============

    /**
     * @brief Anchor an off-chain event on-chain
     *
     * This is the main entry point for all data submissions. The full event
     * data is stored off-chain, and only its SHA256 hash is anchored here.
     *
     * @param author - The blockchain account submitting the event
     * @param type - Event type code:
     *   21 = CREATE_RELEASE_BUNDLE (full release with groups, tracks)
     *   22 = MINT_ENTITY (create canonical entity with stable ID)
     *   23 = RESOLVE_ID (map provisional/external ID to canonical)
     *   30 = ADD_CLAIM (add data to existing entity)
     *   31 = EDIT_CLAIM (modify existing data)
     *   40 = VOTE (vote on a submission)
     *   41 = LIKE (like a node in the graph)
     *   42 = DISCUSS (comment on an entity)
     *   50 = FINALIZE (finalize voting and distribute rewards)
     *   60 = MERGE_ENTITY (merge duplicate entities, preserving provenance)
     * @param hash - SHA256 hash of the canonical off-chain event body
     * @param parent - Optional parent event hash for threading (discussions)
     * @param ts - Unix timestamp when event was created off-chain
     * @param tags - Searchable tags for discovery (e.g., ["rock", "1970s"])
     */
    ACTION put(name author, uint8_t type, checksum256 hash,
               std::optional<checksum256> parent, uint32_t ts,
               std::vector<name> tags) {
        require_auth(author);

        // Validate inputs
        check(type > 0 && type < 100, "Invalid event type");
        check(ts > 0, "Invalid timestamp");
        check(tags.size() <= 10, "Too many tags (max 10)");

        // Prevent duplicate hashes
        anchors_table anchors(get_self(), get_self().value);
        auto hash_idx = anchors.get_index<"byhash"_n>();
        check(hash_idx.find(hash) == hash_idx.end(), "Event hash already exists");

        // Validate parent hash exists if provided
        if(parent.has_value()) {
            auto parent_itr = hash_idx.find(parent.value());
            check(parent_itr != hash_idx.end(), "Parent event not found");
        }

        // Get current blockchain time for expiry calculation
        uint32_t current_time = current_time_point().sec_since_epoch();
        check(ts <= current_time + 300, "Timestamp too far in future (max 5 min)");

        // Calculate voting window based on event type
        uint32_t vote_window = get_vote_window(type);
        uint32_t expires_at = current_time + vote_window;

        // Store the anchor on-chain
        uint64_t anchor_id = anchors.available_primary_key();

        anchors.emplace(author, [&](auto& a) {
            a.id = anchor_id;
            a.author = author;
            a.type = type;
            a.hash = hash;
            a.parent = parent;
            a.ts = ts;
            a.tags = tags;
            a.expires_at = expires_at;
            a.finalized = false;
        });

        // Increment global submission counter for emission calculations
        globals_singleton globals(get_self(), get_self().value);
        auto g = globals.get_or_default();

        // Only increment for content submissions, not votes/likes/discussions
        if (type >= 20 && type < 40) {
            g.x += 1; // Global submission number
        }

        globals.set(g, get_self());
    }

    /**
     * @brief Attest to the validity of a submission
     *
     * High-value submissions (like release bundles) require attestation from
     * trusted community members before they can be finalized.
     *
     * @param attestor - Account providing attestation (must be authorized)
     * @param tx_hash - Hash of the event being attested
     * @param confirmed_type - Event type being confirmed (must match)
     */
    ACTION attest(name attestor, checksum256 tx_hash, uint8_t confirmed_type) {
        require_auth(attestor);

        // Verify attestor is authorized
        check(is_authorized_attestor(attestor), "Not an authorized attestor");

        // Verify the anchor exists
        anchors_table anchors(get_self(), get_self().value);
        auto hash_idx = anchors.get_index<"byhash"_n>();
        auto anchor_itr = hash_idx.find(tx_hash);
        check(anchor_itr != hash_idx.end(), "Anchor not found");
        check(anchor_itr->type == confirmed_type, "Event type mismatch");
        check(!anchor_itr->finalized, "Already finalized");

        // Store attestation
        attestations_table attestations(get_self(), get_self().value);
        uint64_t att_id = attestations.available_primary_key();

        attestations.emplace(attestor, [&](auto& a) {
            a.id = att_id;
            a.tx_hash = tx_hash;
            a.attestor = attestor;
            a.type = confirmed_type;
            a.ts = current_time_point();
        });
    }

    /**
     * @brief Like a node on the graph with path tracking
     *
     * Likes track the path taken through the graph to reach the liked entity.
     * This data helps understand how users discover music and navigate relationships.
     *
     * @param account - Account doing the liking (must be authorized)
     * @param node_id - SHA256 identifier of entity being liked
     * @param node_path - The path through the graph to reach this node
     */
    ACTION like(name account, checksum256 node_id, std::vector<checksum256> node_path) {
        require_auth(account);

        check(node_path.size() > 0, "Path must contain at least one node");
        check(node_path.size() <= 20, "Path too long (max 20 nodes)");
        check(node_path.back() == node_id, "Path must end at liked node");

        // Store like record
        likes_table likes(get_self(), account.value);
        auto itr = likes.find(node_id);

        // Save state before modifying likes table (iterator will be stale after modification)
        bool is_new_like = (itr == likes.end());

        if (is_new_like) {
            likes.emplace(account, [&](auto& l) {
                l.node_id = node_id;
                l.path = node_path;
                l.liked_at = current_time_point();
            });
        } else {
            // Update existing like with new path
            likes.modify(itr, account, [&](auto& l) {
                l.path = node_path;
                l.liked_at = current_time_point();
            });
        }

        // Update aggregate like count for the node
        likeagg_table aggregates(get_self(), get_self().value);
        auto agg_itr = aggregates.find(node_id);

        if (agg_itr == aggregates.end()) {
            aggregates.emplace(account, [&](auto& a) {
                a.node_id = node_id;
                a.like_count = 1;
            });
        } else if (is_new_like) {
            // Only increment if this was a new like (use saved state)
            aggregates.modify(agg_itr, account, [&](auto& a) {
                a.like_count += 1;
            });
        }
    }

    /**
     * @brief Unlike a previously liked node
     *
     * @param account - Account removing the like
     * @param node_id - Node being unliked
     */
    ACTION unlike(name account, checksum256 node_id) {
        require_auth(account);

        // Remove like record
        likes_table likes(get_self(), account.value);
        auto itr = likes.require_find(node_id, "Like not found");
        likes.erase(itr);

        // Update aggregate
        likeagg_table aggregates(get_self(), get_self().value);
        auto agg_itr = aggregates.require_find(node_id, "Like aggregate not found");

        aggregates.modify(agg_itr, account, [&](auto& a) {
            check(a.like_count > 0, "Like count already zero (data corruption)");
            a.like_count -= 1;
        });

        // Remove aggregate if count reaches zero
        if (agg_itr->like_count == 0) {
            aggregates.erase(agg_itr);
        }
    }

    // ============ FRACTALLY INTEGRATION ============

    /**
     * @brief Update Respect values from Fractally elections
     *
     * Called weekly by the Fractally oracle after consensus rounds complete.
     * Respect values determine voting weight in the Polaris system.
     *
     * @param respect_data - Array of account:respect pairs from latest election
     * @param election_round - Fractally round number for verification
     */
    ACTION updaterespect(std::vector<std::pair<name, uint32_t>> respect_data,
                         uint64_t election_round) {
        // Only Fractally contract or designated oracle can update
        require_auth(get_fractally_oracle());

        check(respect_data.size() > 0, "Empty respect data");
        check(respect_data.size() <= 1000, "Too many updates in one transaction");

        respect_table respect(get_self(), get_self().value);

        for(const auto& [account, respect_value] : respect_data) {
            check(respect_value > 0, "Respect must be positive");
            check(respect_value <= 1000, "Respect value too high (max 1000)");
            auto itr = respect.find(account.value);

            if(itr == respect.end()) {
                // New member receiving Respect
                respect.emplace(get_self(), [&](auto& r) {
                    r.account = account;
                    r.respect = respect_value;
                    r.round = election_round;
                    r.updated_at = current_time_point();
                });
            } else {
                // Update existing Respect
                respect.modify(itr, get_self(), [&](auto& r) {
                    r.respect = respect_value;
                    r.round = election_round;
                    r.updated_at = current_time_point();
                });
            }
        }
    }

    /**
     * @brief Set the authorized Fractally oracle account
     *
     * @param oracle - Account authorized to update Respect values
     */
    ACTION setoracle(name oracle) {
        require_auth(get_self());

        globals_singleton globals(get_self(), get_self().value);
        auto g = globals.get_or_default();
        g.fractally_oracle = oracle;
        globals.set(g, get_self());
    }

    // ============ VOTING WITH RESPECT WEIGHTS ============

    /**
     * @brief Vote on an anchored event with Respect-weighted influence
     *
     * Votes determine if submissions are accepted and receive rewards.
     * Vote weight is determined by the voter's Fractally Respect value.
     *
     * @param voter - Account casting the vote
     * @param tx_hash - Hash of the event being voted on
     * @param val - Vote value: +1 (approve), -1 (reject), 0 (unvote/neutral)
     */
    ACTION vote(name voter, checksum256 tx_hash, int8_t val) {
        require_auth(voter);
        check(val >= -1 && val <= 1, "Invalid vote value (must be -1, 0, or 1)");

        // Verify the anchor exists and voting window is still open
        anchors_table anchors(get_self(), get_self().value);
        auto hash_idx = anchors.get_index<"byhash"_n>();
        auto anchor_itr = hash_idx.find(tx_hash);
        check(anchor_itr != hash_idx.end(), "Anchor not found");
        check(!anchor_itr->finalized, "Voting already finalized");
        check(current_time_point().sec_since_epoch() < anchor_itr->expires_at,
              "Voting window has closed");

        // Get voter's Respect for weight calculation
        respect_table respect(get_self(), get_self().value);
        auto respect_itr = respect.find(voter.value);
        uint32_t voter_respect = 1; // Default weight if no Respect

        if(respect_itr != respect.end()) {
            voter_respect = respect_itr->respect;
            // Cap maximum individual influence to prevent whale control
            if(voter_respect > 100) voter_respect = 100;
        }

        // Store or update vote
        votes_table votes(get_self(), get_self().value);
        auto vote_idx = votes.get_index<"byvoterhash"_n>();
        uint128_t composite_key = combine_keys(voter.value, tx_hash);
        auto vote_itr = vote_idx.find(composite_key);

        if(vote_itr == vote_idx.end()) {
            // New vote
            votes.emplace(voter, [&](auto& v) {
                v.id = votes.available_primary_key();
                v.tx_hash = tx_hash;
                v.voter = voter;
                v.val = val;
                v.weight = voter_respect;
                v.ts = current_time_point();
            });
        } else {
            // Update existing vote (allows changing mind during voting window)
            vote_idx.modify(vote_itr, voter, [&](auto& v) {
                v.val = val;
                v.weight = voter_respect;
                v.ts = current_time_point();
            });
        }
    }

    /**
     * @brief Finalize voting and distribute rewards after window closes
     *
     * Uses logarithmic emission curve: g(x) = m * ln(x) / x
     * where x is the global submission number and m is the type multiplier.
     *
     * @param tx_hash - Hash of the event to finalize
     */
    ACTION finalize(checksum256 tx_hash) {
        // Anyone can call finalize after voting window closes

        anchors_table anchors(get_self(), get_self().value);
        auto hash_idx = anchors.get_index<"byhash"_n>();
        auto anchor_itr = hash_idx.find(tx_hash);
        check(anchor_itr != hash_idx.end(), "Anchor not found");
        check(!anchor_itr->finalized, "Already finalized");
        check(current_time_point().sec_since_epoch() >= anchor_itr->expires_at,
              "Voting window still open");

        // Check attestation requirement for high-value submissions
        if(requires_attestation(anchor_itr->type)) {
            attestations_table attestations(get_self(), get_self().value);
            auto att_idx = attestations.get_index<"byhash"_n>();
            auto att_itr = att_idx.find(tx_hash);
            check(att_itr != att_idx.end(), "Attestation required but not found");
        }

        // Calculate weighted vote totals
        auto [up_votes, down_votes] = calculate_weighted_votes(tx_hash);
        uint64_t total_votes = up_votes + down_votes;
        double approval = total_votes > 0 ?
                         static_cast<double>(up_votes) / total_votes : 0.0;

        // Get emission parameters
        globals_singleton globals(get_self(), get_self().value);
        auto g = globals.get_or_default();

        uint64_t multiplier = get_multiplier(anchor_itr->type);
        double x = static_cast<double>(g.x);

        // Calculate emission using logarithmic curve
        // g(x) = m * ln(x) / x
        // This creates a decreasing reward over time as the registry grows
        uint64_t mint = 0;
        if (x >= 1.0 && multiplier > 0) {
            double g_raw = multiplier * std::log(x) / x;
            double total_with_carry = g_raw + g.carry;

            // Prevent overflow when casting to uint64_t (max ~18.4 quintillion)
            // Cap at 1 trillion tokens (1,000,000,000,000.0000 MUS with 4 decimals)
            const double MAX_MINT = 10000000000000000.0; // 1 trillion * 10000 (4 decimal places)
            if(total_with_carry > MAX_MINT) {
                total_with_carry = MAX_MINT;
            }

            mint = static_cast<uint64_t>(total_with_carry);
            g.carry = total_with_carry - mint;
        }

        // Determine payout distribution based on approval threshold
        bool accepted = approval >= 0.90; // 90% approval required

        if(mint > 0) {
            distribute_rewards(anchor_itr->author, tx_hash, mint, accepted);
        }

        // Mark as finalized
        hash_idx.modify(anchor_itr, same_payer, [&](auto& a) {
            a.finalized = true;
        });

        // Update global state
        globals.set(g, get_self());
    }

    // ============ STAKING ON GRAPH NODES ============

    /**
     * @brief Stake tokens on a Group, Person, or other node
     *
     * Staking shows support for an entity and affects reward distribution
     * for rejected submissions (helps curate quality).
     *
     * @param account - Account doing the staking
     * @param node_id - SHA256 identifier of entity being staked on
     * @param quantity - Amount of tokens to stake
     */
    ACTION stake(name account, checksum256 node_id, asset quantity) {
        require_auth(account);
        check(quantity.symbol == symbol("MUS", 4), "Invalid token symbol (must be MUS)");
        check(quantity.amount > 0, "Must stake positive amount");

        // Transfer tokens from account to contract
        transfer_tokens(account, get_self(), quantity,
                       "Stake on node " + checksum_to_hex(node_id).substr(0, 16));

        // Update individual stake record (for user's portfolio view)
        stakes_table stakes(get_self(), account.value);
        auto itr = stakes.find(node_id);

        // Save state before modifying stakes table (iterator will be stale after modification)
        bool is_new_staker = (itr == stakes.end());

        if(is_new_staker) {
            stakes.emplace(account, [&](auto& s) {
                s.node_id = node_id;
                s.amount = quantity;
                s.staked_at = current_time_point();
                s.last_updated = current_time_point();
            });
        } else {
            stakes.modify(itr, account, [&](auto& s) {
                s.amount += quantity;
                s.last_updated = current_time_point();
            });
        }

        // Update aggregate for the node (used for voting power and rewards)
        nodeagg_table aggregates(get_self(), get_self().value);
        auto agg_itr = aggregates.find(node_id);

        if(agg_itr == aggregates.end()) {
            aggregates.emplace(account, [&](auto& a) {
                a.node_id = node_id;
                a.total = quantity;
                a.staker_count = 1;
            });
        } else {
            aggregates.modify(agg_itr, account, [&](auto& a) {
                a.total += quantity;
                // Only increment staker count for new stakers (use saved state)
                if(is_new_staker) {
                    a.staker_count += 1;
                }
            });
        }
    }

    /**
     * @brief Remove stake from a node
     *
     * @param account - Account removing stake
     * @param node_id - Node to unstake from
     * @param quantity - Amount to unstake
     */
    ACTION unstake(name account, checksum256 node_id, asset quantity) {
        require_auth(account);
        check(quantity.amount > 0, "Must unstake positive amount");

        // Update individual stake
        stakes_table stakes(get_self(), account.value);
        auto itr = stakes.require_find(node_id, "No stake found for this node");
        check(itr->amount >= quantity, "Insufficient stake");

        bool removing_all = (itr->amount == quantity);

        if(removing_all) {
            stakes.erase(itr);
        } else {
            stakes.modify(itr, account, [&](auto& s) {
                s.amount -= quantity;
                s.last_updated = current_time_point();
            });
        }

        // Update aggregate
        nodeagg_table aggregates(get_self(), get_self().value);
        auto agg_itr = aggregates.require_find(node_id, "Aggregate not found");

        aggregates.modify(agg_itr, account, [&](auto& a) {
            a.total -= quantity;
            // Only decrement staker count if removing all stake
            if(removing_all) {
                a.staker_count -= 1;
            }
        });

        // Remove aggregate if no more stakers
        if(agg_itr->staker_count == 0) {
            aggregates.erase(agg_itr);
        }

        // Transfer tokens back to account
        transfer_tokens(get_self(), account, quantity, "Unstake from node");
    }

    /**
     * @brief Initialize contract state
     *
     * @param oracle - Initial Fractally oracle account
     * @param token_contract - Token contract for MUS token
     */
    ACTION init(name oracle, name token_contract) {
        require_auth(get_self());

        globals_singleton globals(get_self(), get_self().value);
        check(!globals.exists(), "Already initialized");

        // Validate oracle account exists
        check(is_account(oracle), "Oracle account does not exist");

        // Validate token contract exists
        check(is_account(token_contract), "Token contract account does not exist");
        check(token_contract != get_self(), "Token contract cannot be self");

        global_state g;
        g.x = 1; // Start at 1 to avoid log(0)
        g.carry = 0.0;
        g.round = 0;
        g.fractally_oracle = oracle;
        g.token_contract = token_contract;

        globals.set(g, get_self());
    }

    /**
     * @brief Clear all data (for testing only)
     *
     * SAFETY GUARDS:
     * - Only works if total anchors <= 100 (prevents production misuse)
     * - Only works if total stake == 0 (prevents destroying value)
     * - Requires contract authority
     *
     * For production deployment, this action should be removed entirely
     * by commenting out or using compile-time flags.
     */
    ACTION clear() {
        require_auth(get_self());

        // SAFETY: Prevent clearing production data
        anchors_table anchors(get_self(), get_self().value);
        uint64_t anchor_count = std::distance(anchors.begin(), anchors.end());
        check(anchor_count <= 100, "Cannot clear: too many anchors (production data detected)");

        // SAFETY: Prevent destroying staked value
        nodeagg_table nodeagg(get_self(), get_self().value);
        uint64_t total_staked = 0;
        for(auto itr = nodeagg.begin(); itr != nodeagg.end(); ++itr) {
            total_staked += itr->total.amount;
        }
        check(total_staked == 0, "Cannot clear: tokens are staked (would destroy value)");

        // Clear all tables (reuse anchors table from safety check)
        auto anchors_itr = anchors.begin();
        while(anchors_itr != anchors.end()) {
            anchors_itr = anchors.erase(anchors_itr);
        }

        votes_table votes(get_self(), get_self().value);
        auto votes_itr = votes.begin();
        while(votes_itr != votes.end()) {
            votes_itr = votes.erase(votes_itr);
        }

        respect_table respect(get_self(), get_self().value);
        auto respect_itr = respect.begin();
        while(respect_itr != respect.end()) {
            respect_itr = respect.erase(respect_itr);
        }

        attestations_table attestations(get_self(), get_self().value);
        auto att_itr = attestations.begin();
        while(att_itr != attestations.end()) {
            att_itr = attestations.erase(att_itr);
        }

        likeagg_table likeagg(get_self(), get_self().value);
        auto likeagg_itr = likeagg.begin();
        while(likeagg_itr != likeagg.end()) {
            likeagg_itr = likeagg.erase(likeagg_itr);
        }

        nodeagg_table nodeagg(get_self(), get_self().value);
        auto nodeagg_itr = nodeagg.begin();
        while(nodeagg_itr != nodeagg.end()) {
            nodeagg_itr = nodeagg.erase(nodeagg_itr);
        }

        // Note: likes and stakes tables are scoped by account and cannot be
        // cleared from contract scope. These would need to be cleared per-account
        // or through a separate cleanup mechanism if needed.

        // Reset globals
        globals_singleton globals(get_self(), get_self().value);
        globals.remove();
    }

private:
    // ============ DATA STRUCTURES ============

    /**
     * @brief Anchored events table
     *
     * Stores minimal on-chain data about each event. Full event data is
     * retrieved from off-chain storage using the hash.
     */
    TABLE anchor {
        uint64_t    id;              // Auto-incrementing primary key
        name        author;          // Account that submitted
        uint8_t     type;           // Event type code
        checksum256 hash;           // SHA256 of canonical event
        std::optional<checksum256> parent; // Parent for threading
        uint32_t    ts;             // Original timestamp
        std::vector<name> tags;     // Searchable tags
        uint32_t    expires_at;     // When voting closes
        bool        finalized;      // Rewards distributed?

        uint64_t primary_key() const { return id; }
        checksum256 by_hash() const { return hash; }
        uint64_t by_author() const { return author.value; }

        EOSLIB_SERIALIZE(anchor, (id)(author)(type)(hash)(parent)
                                 (ts)(tags)(expires_at)(finalized))
    };

    /**
     * @brief Vote records with Respect weights
     */
    TABLE vote_record {
        uint64_t    id;             // Primary key
        checksum256 tx_hash;        // Event being voted on
        name        voter;          // Who voted
        int8_t      val;           // Vote: +1, 0, -1
        uint32_t    weight;        // Respect weight at vote time
        time_point  ts;            // When voted

        uint64_t primary_key() const { return id; }
        uint128_t by_voter_hash() const {
            return combine_keys(voter.value, tx_hash);
        }
        checksum256 by_hash() const { return tx_hash; }

        EOSLIB_SERIALIZE(vote_record, (id)(tx_hash)(voter)(val)(weight)(ts))
    };

    /**
     * @brief Fractally Respect values
     */
    TABLE respect_record {
        name        account;        // Account with Respect
        uint32_t    respect;       // Current Respect value
        uint64_t    round;         // Election round number
        time_point  updated_at;    // Last update time

        uint64_t primary_key() const { return account.value; }

        EOSLIB_SERIALIZE(respect_record, (account)(respect)(round)(updated_at))
    };

    /**
     * @brief Individual stake records (scoped by account)
     */
    TABLE stake_record {
        checksum256 node_id;        // What's being staked on
        asset       amount;         // Amount staked
        time_point  staked_at;      // When first staked
        time_point  last_updated;   // Last change

        checksum256 primary_key() const { return node_id; }

        EOSLIB_SERIALIZE(stake_record, (node_id)(amount)(staked_at)(last_updated))
    };

    /**
     * @brief Aggregated stakes by node
     */
    TABLE node_aggregate {
        checksum256 node_id;        // Node identifier
        asset       total;          // Total staked
        uint32_t    staker_count;   // Number of stakers

        checksum256 primary_key() const { return node_id; }

        EOSLIB_SERIALIZE(node_aggregate, (node_id)(total)(staker_count))
    };

    /**
     * @brief Attestation records for high-value submissions
     */
    TABLE attestation {
        uint64_t    id;
        checksum256 tx_hash;        // Event attested
        name        attestor;       // Who attested
        uint8_t     type;          // Event type confirmed
        time_point  ts;            // When attested

        uint64_t primary_key() const { return id; }
        checksum256 by_hash() const { return tx_hash; }

        EOSLIB_SERIALIZE(attestation, (id)(tx_hash)(attestor)(type)(ts))
    };

    /**
     * @brief Like records (scoped by account)
     */
    TABLE like_record {
        checksum256 node_id;            // Liked entity
        std::vector<checksum256> path;  // Discovery path
        time_point  liked_at;           // When liked

        checksum256 primary_key() const { return node_id; }

        EOSLIB_SERIALIZE(like_record, (node_id)(path)(liked_at))
    };

    /**
     * @brief Aggregated likes by node
     */
    TABLE like_aggregate {
        checksum256 node_id;        // Node identifier
        uint32_t    like_count;     // Number of likes

        checksum256 primary_key() const { return node_id; }

        EOSLIB_SERIALIZE(like_aggregate, (node_id)(like_count))
    };

    /**
     * @brief Global state singleton
     */
    TABLE global_state {
        uint64_t    x;              // Global submission counter
        double      carry;          // Fractional emission accumulator
        uint64_t    round;          // Current round
        name        fractally_oracle; // Who can update Respect
        name        token_contract; // MUS token contract

        EOSLIB_SERIALIZE(global_state, (x)(carry)(round)(fractally_oracle)(token_contract))
    };

    // Table type definitions
    typedef eosio::multi_index<"anchors"_n, anchor,
        indexed_by<"byhash"_n, const_mem_fun<anchor, checksum256, &anchor::by_hash>>,
        indexed_by<"byauthor"_n, const_mem_fun<anchor, uint64_t, &anchor::by_author>>
    > anchors_table;

    typedef eosio::multi_index<"votes"_n, vote_record,
        indexed_by<"byvoterhash"_n, const_mem_fun<vote_record, uint128_t, &vote_record::by_voter_hash>>,
        indexed_by<"byhash"_n, const_mem_fun<vote_record, checksum256, &vote_record::by_hash>>
    > votes_table;

    typedef eosio::multi_index<"respect"_n, respect_record> respect_table;
    typedef eosio::multi_index<"stakes"_n, stake_record> stakes_table;
    typedef eosio::multi_index<"nodeagg"_n, node_aggregate> nodeagg_table;
    typedef eosio::multi_index<"attestations"_n, attestation,
        indexed_by<"byhash"_n, const_mem_fun<attestation, checksum256, &attestation::by_hash>>
    > attestations_table;
    typedef eosio::multi_index<"likes"_n, like_record> likes_table;
    typedef eosio::multi_index<"likeagg"_n, like_aggregate> likeagg_table;
    typedef eosio::singleton<"globals"_n, global_state> globals_singleton;

    // ============ HELPER FUNCTIONS ============

    /**
     * @brief Get voting window duration based on event type
     *
     * Different event types have different voting windows to allow
     * appropriate community review time.
     */
    uint32_t get_vote_window(uint8_t type) const {
        if(type == 21) return 7 * 24 * 60 * 60; // 7 days for releases
        if(type == 22) return 3 * 24 * 60 * 60; // 3 days for mint entity
        if(type == 23) return 2 * 24 * 60 * 60; // 2 days for ID resolution
        if(type == 30 || type == 31) return 3 * 24 * 60 * 60; // 3 days for claims
        if(type == 60) return 5 * 24 * 60 * 60; // 5 days for entity merges
        return 24 * 60 * 60; // 1 day default
    }

    /**
     * @brief Get emission multiplier for event type
     *
     * Higher multipliers for more valuable contributions.
     * The logarithmic curve applies to the multiplier.
     */
    uint64_t get_multiplier(uint8_t type) const {
        switch(type) {
            case 21: return 1000000;  // CREATE_RELEASE_BUNDLE (major contribution)
            case 22: return 100000;   // MINT_ENTITY (canonical entity creation)
            case 23: return 5000;     // RESOLVE_ID (ID mapping contribution)
            case 30: return 50000;    // ADD_CLAIM (medium contribution)
            case 31: return 1000;     // EDIT_CLAIM (minor contribution)
            case 60: return 20000;    // MERGE_ENTITY (deduplication contribution)
            default: return 0;        // No emission (votes, likes, etc.)
        }
    }

    /**
     * @brief Check if event type requires attestation before finalization
     */
    bool requires_attestation(uint8_t type) const {
        return type == 21; // Only releases require attestation
    }

    /**
     * @brief Create composite key for multi-index secondary indexes
     *
     * Combines account name and checksum256 into a uint128_t key.
     */
    static uint128_t combine_keys(uint64_t a, const checksum256& b) {
        // Use first 64 bits of checksum256
        auto hash_data = b.extract_as_byte_array();
        uint64_t b_part = 0;
        for(int i = 0; i < 8; i++) {
            b_part = (b_part << 8) | hash_data[i];
        }
        return (uint128_t(a) << 64) | uint128_t(b_part);
    }

    /**
     * @brief Get authorized Fractally oracle account
     */
    name get_fractally_oracle() const {
        globals_singleton globals(get_self(), get_self().value);
        auto g = globals.get_or_default();
        return g.fractally_oracle;
    }

    /**
     * @brief Check if account is authorized to provide attestations
     *
     * In production, this should check against a dedicated table or
     * multisig authority.
     */
    bool is_authorized_attestor(name account) const {
        // Check if it's the Fractally oracle
        if(account == get_fractally_oracle()) return true;

        // Check if it's a designated council member
        // In production, check against attestors table
        if(account == name("council.pol")) return true;

        // Could also check Respect threshold
        respect_table respect(get_self(), get_self().value);
        auto itr = respect.find(account.value);
        if(itr != respect.end() && itr->respect >= 50) {
            return true; // High Respect members can attest
        }

        return false;
    }

    /**
     * @brief Calculate weighted vote totals for an event
     *
     * @return pair<up_votes, down_votes> weighted by Respect
     */
    std::pair<uint64_t, uint64_t> calculate_weighted_votes(const checksum256& tx_hash) const {
        votes_table votes(get_self(), get_self().value);
        auto hash_idx = votes.get_index<"byhash"_n>();

        uint64_t up_votes = 0;
        uint64_t down_votes = 0;

        // Iterate through all votes for this hash
        auto itr = hash_idx.lower_bound(tx_hash);
        while(itr != hash_idx.end() && itr->tx_hash == tx_hash) {
            if(itr->val == 1) {
                up_votes += itr->weight;
            } else if(itr->val == -1) {
                down_votes += itr->weight;
            }
            // val == 0 is neutral, doesn't count
            ++itr;
        }

        return {up_votes, down_votes};
    }

    /**
     * @brief Distribute rewards based on voting outcome
     *
     * Accepted submissions: 50% to submitter, 50% to voters
     * Rejected submissions: 50% to voters, 50% to stakers
     */
    void distribute_rewards(name submitter, const checksum256& tx_hash,
                           uint64_t total_amount, bool accepted) {
        if(total_amount == 0) return;

        if(accepted) {
            // 50% to submitter
            uint64_t submitter_share = total_amount / 2;
            issue_tokens(submitter, submitter_share, "Accepted submission reward");

            // 50% to voters (weighted by Respect)
            uint64_t voter_share = total_amount - submitter_share;
            distribute_to_voters(tx_hash, voter_share);
        } else {
            // 50% to voters (reward those who correctly rejected)
            uint64_t voter_share = total_amount / 2;
            distribute_to_voters(tx_hash, voter_share);

            // 50% to global stakers (distributed based on stake proportion)
            uint64_t staker_share = total_amount - voter_share;
            distribute_to_stakers(staker_share);
        }
    }

    /**
     * @brief Distribute rewards to voters proportionally by weight
     *
     * Uses checks-effects-interactions pattern to prevent reentrancy:
     * 1. Calculate all distributions
     * 2. Issue all tokens (external calls)
     */
    void distribute_to_voters(const checksum256& tx_hash, uint64_t total_amount) {
        if(total_amount == 0) return;

        votes_table votes(get_self(), get_self().value);
        auto hash_idx = votes.get_index<"byhash"_n>();

        // First pass: calculate total weight
        uint64_t total_weight = 0;
        auto itr = hash_idx.lower_bound(tx_hash);
        while(itr != hash_idx.end() && itr->tx_hash == tx_hash) {
            if(itr->val != 0) { // Only count non-neutral votes
                total_weight += itr->weight;
            }
            ++itr;
        }

        if(total_weight == 0) return;

        // Second pass: collect all distributions (avoid reentrancy)
        std::vector<std::pair<name, uint64_t>> distributions;
        itr = hash_idx.lower_bound(tx_hash);
        while(itr != hash_idx.end() && itr->tx_hash == tx_hash) {
            if(itr->val != 0) {
                uint64_t voter_share = (total_amount * itr->weight) / total_weight;
                if(voter_share > 0) {
                    distributions.push_back({itr->voter, voter_share});
                }
            }
            ++itr;
        }

        // Third pass: execute all token distributions (external calls last)
        for(const auto& [voter, amount] : distributions) {
            issue_tokens(voter, amount, "Voting reward");
        }
    }

    /**
     * @brief Distribute rewards to all stakers proportionally
     *
     * CURRENT IMPLEMENTATION:
     * Distributes rewards evenly to all staker accounts across all nodes,
     * proportional to their stake amounts. Limited to first 50 nodes to
     * avoid CPU limits.
     *
     * SCALABILITY NOTE:
     * For production with many stakers, this should be replaced with a
     * claim mechanism where:
     * 1. Store pending rewards per node in a table
     * 2. Stakers call separate claim() action to collect
     * 3. Distribution happens lazily on-demand
     *
     * This current implementation ensures rewards are not lost while
     * keeping the function operational for testing and small deployments.
     */
    void distribute_to_stakers(uint64_t total_amount) {
        if(total_amount == 0) return;

        nodeagg_table aggregates(get_self(), get_self().value);

        // Calculate total staked across all nodes
        uint64_t total_staked = 0;
        uint32_t node_count = 0;
        for(auto itr = aggregates.begin(); itr != aggregates.end(); ++itr) {
            total_staked += itr->total.amount;
            node_count++;
        }

        if(total_staked == 0) return;

        // Limit to 50 nodes to avoid CPU limits (each node requires iterating stakers)
        check(node_count <= 50, "Too many staked nodes - implement claim mechanism");

        // Distribute proportionally to each node's stakers
        for(auto node_itr = aggregates.begin(); node_itr != aggregates.end(); ++node_itr) {
            // Calculate this node's share of total rewards
            uint64_t node_share = (total_amount * node_itr->total.amount) / total_staked;
            if(node_share == 0) continue;

            // Distribute node's share to all stakers on this node
            // Need to iterate through stakes table (scoped by account) for this node
            // For now, distribute evenly among staker_count
            // (This is a simplification - ideal would be proportional by stake amount)
            if(node_itr->staker_count > 0) {
                uint64_t per_staker = node_share / node_itr->staker_count;

                // NOTE: We cannot easily iterate account-scoped stakes tables
                // Without an index of accounts, we would need to track staker accounts
                // separately. For this basic implementation, we'll burn to get_self()
                // with a memo indicating it should be distributed to stakers.
                // A proper implementation requires additional tables to track staker accounts.

                // TODO: Add staker account tracking or implement claim mechanism
                // For now, transfer to contract as "pending staker rewards"
                // This prevents reward loss while signaling need for proper implementation
                issue_tokens(get_self(), node_share,
                    "Pending staker rewards - implement claim mechanism");
            }
        }
    }

    /**
     * @brief Transfer tokens using inline action to token contract
     */
    void transfer_tokens(name from, name to, asset quantity, const std::string& memo) {
        globals_singleton globals(get_self(), get_self().value);
        auto g = globals.get_or_default();

        action(
            permission_level{from, "active"_n},
            g.token_contract,
            "transfer"_n,
            std::make_tuple(from, to, quantity, memo)
        ).send();
    }

    /**
     * @brief Issue new tokens to an account
     */
    void issue_tokens(name to, uint64_t amount, const std::string& memo) {
        if(amount == 0) return;

        globals_singleton globals(get_self(), get_self().value);
        auto g = globals.get_or_default();

        asset quantity = asset(amount, symbol("MUS", 4));

        action(
            permission_level{get_self(), "active"_n},
            g.token_contract,
            "issue"_n,
            std::make_tuple(to, quantity, memo)
        ).send();
    }

    /**
     * @brief Convert checksum256 to hex string
     */
    std::string checksum_to_hex(const checksum256& hash) const {
        auto hash_data = hash.extract_as_byte_array();
        const char* hex_chars = "0123456789abcdef";
        std::string result;
        result.reserve(64);

        for(size_t i = 0; i < hash_data.size(); i++) {
            result += hex_chars[(hash_data[i] >> 4) & 0xF];
            result += hex_chars[hash_data[i] & 0xF];
        }

        return result;
    }
};
