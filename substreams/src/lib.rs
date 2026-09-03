mod abi;
mod pb;

use substreams::errors::Error;
use substreams::log;
use substreams::prelude::*;
use substreams::store::{StoreAddInt64, StoreGetInt64};
use substreams_antelope::pb::{ActionTraces, Block};
use substreams_antelope::Action;

use pb::polaris::v1::{
    AnchoredEvent, AnchoredEvents, AttestEvent, Event, EventData, Events, FinalizeEvent,
    LikeEvent, PutEvent, RespectUpdate, StakeEvent, Stats, UnlikeEvent, UnstakeEvent,
    UpdateRespectEvent, VoteEvent,
};

/// Map module: Extract all Polaris Music Registry events from blocks
///
/// PERF-05: Uses `block.action_traces()` iterator for streaming processing,
/// avoiding intermediate Vec allocations for non-matching actions.
/// Defers string allocations (tx_hash) until a matching action is found.
#[substreams::handlers::map]
fn map_events(params: String, block: Block) -> Result<Events, Error> {
    let contract_account = if params.is_empty() {
        "polaris"
    } else {
        &params
    };

    // PERF-05: Use block.action_traces() iterator (already filters for executed transactions)
    // instead of manual nested loops with Vec::push
    let events: Vec<Event> = block
        .action_traces()
        .filter_map(|(action_trace, trx)| {
            // Only process actions received by our contract
            if action_trace.receiver != contract_account {
                return None;
            }

            let action = action_trace.action.as_ref()?;
            let block_num = block.number as u64;
            let timestamp = block
                .header
                .as_ref()
                .and_then(|h| h.timestamp.as_ref())
                .map(|t| t.seconds as u64)
                .unwrap_or(0);

            match action.name.as_str() {
                "put" => extract_put_event(&trx.id, block_num, timestamp, action_trace),
                "attest" => extract_attest_event(&trx.id, block_num, timestamp, action_trace),
                "vote" => extract_vote_event(&trx.id, block_num, timestamp, action_trace),
                "finalize" => extract_finalize_event(&trx.id, block_num, timestamp, action_trace),
                "stake" => extract_stake_event(&trx.id, block_num, timestamp, action_trace),
                "unstake" => extract_unstake_event(&trx.id, block_num, timestamp, action_trace),
                "like" => extract_like_event(&trx.id, block_num, timestamp, action_trace),
                "unlike" => extract_unlike_event(&trx.id, block_num, timestamp, action_trace),
                "updrespect" => {
                    extract_update_respect_event(&trx.id, block_num, timestamp, action_trace)
                }
                _ => None, // Ignore other actions (setoracle, init, etc.)
            }
        })
        .collect();

    log::info!(
        "Extracted {} events from block {}",
        events.len(),
        block.number
    );

    Ok(Events { events })
}

/// Map module: Extract anchored events with full blockchain provenance (T5/T6)
/// This is the primary output for chain ingestion pipeline
///
/// CRITICAL: Uses put.hash as content_hash (canonical identifier from blockchain)
/// instead of computing hash from action JSON (which is unstable across sources)
///
/// PERF-05: Uses iterator-based processing with early filtering.
/// Pre-computes block-level values once, defers per-trx allocations.
/// Extract the contract account from this module's params.
///
/// The params double as the `blockFilter` query, so that the provider can skip
/// blocks holding no action for our contract instead of streaming every block
/// to be filtered here. That saved bandwidth is the whole point: an unfiltered
/// run costs the same 4.3 MiB per 10,000 blocks whether it matches anything or
/// not.
///
/// The query grammar is the foundational modules' (`code:`, `action:`,
/// `receiver:`, joined by `&&` / `||`), so a `code:` term is pulled back out
/// here rather than duplicating the account in the manifest, where it would
/// drift from CONTRACT_ACCOUNT.
///
/// A bare account name is still accepted, because that is what every existing
/// deployment passes and a params change that silently matched nothing would be
/// indistinguishable from a quiet chain.
fn contract_account_from_params(params: &str) -> &str {
    let trimmed = params.trim();
    if trimmed.is_empty() {
        return "polaris";
    }

    for term in trimmed.split(|c| c == '&' || c == '|') {
        let term = term.trim().trim_matches(|c| c == '(' || c == ')').trim();
        if let Some(account) = term.strip_prefix("code:") {
            let account = account.trim();
            if !account.is_empty() {
                return account;
            }
        }
    }

    // No `code:` term — treat the whole thing as a bare account name.
    trimmed
}

/// Build the backend's JSON payload for an action, decoding it from raw_data.
///
/// Used when Firehose supplies no `json_data` — its decoding depends on the ABI
/// it has cached for the account, and a redeploy that changes an action's
/// arguments can leave that stale. The package embeds its own ABI, so the
/// actions we have bindings for can always be read here regardless.
///
/// The field names match what the backend already destructures off the action
/// payload: processPutAction reads author/type/hash/event_cid/parent/ts/tags,
/// processCurationAction reads voter/tx_hash/val/memo, and processLikeAction
/// reads account/node_id/node_path (ingestion.js).
///
/// @returns the payload JSON and the content hash to key it by, or None when
/// the action cannot be decoded or is not one we ingest.
fn decode_action_payload(
    action_trace: &substreams_antelope::pb::ActionTrace,
    name: &str,
) -> Option<(String, String)> {
    use abi::polaris_music::actions;

    match name {
        "put" => Some(put_payload(&actions::Put::decode(action_trace).ok()?)),
        "vote" => Some(vote_payload(&actions::Vote::decode(action_trace).ok()?)),
        "finalize" => Some(finalize_payload(&actions::Finalize::decode(action_trace).ok()?)),
        "like" => Some(like_payload(&actions::Like::decode(action_trace).ok()?)),
        "unlike" => Some(unlike_payload(&actions::Unlike::decode(action_trace).ok()?)),
        _ => None,
    }
}

/// Hash a payload to key it by.
///
/// Everything except `put` is keyed this way: those actions carry no content
/// hash of their own, and the backend dedups on this value rather than reading
/// it.
fn hashed(payload: serde_json::Value) -> (String, String) {
    use sha2::{Digest, Sha256};

    let json = payload.to_string();
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    (json, hex::encode(hasher.finalize()))
}

/// @see processPutAction, which destructures these exact names.
fn put_payload(a: &abi::polaris_music::actions::Put) -> (String, String) {
    let payload = serde_json::json!({
        "author": a.author,
        "type": a.type_,
        "hash": &a.hash,
        "event_cid": a.event_cid,
        "parent": a.parent,
        "ts": a.ts,
        "tags": a.tags,
    });
    // In 0.6, Checksum256 fields are already hex strings, and put carries the
    // content hash the whole system keys on — so it is used rather than derived.
    (payload.to_string(), a.hash.clone())
}

/// @see processCurationAction.
fn vote_payload(a: &abi::polaris_music::actions::Vote) -> (String, String) {
    hashed(serde_json::json!({
        "voter": a.voter,
        "tx_hash": a.tx_hash,
        "val": a.val,
        // The curator's reason. The contract validates it and stores nothing,
        // so this trace is the only record there will ever be of it.
        "memo": a.memo,
    }))
}

/// @see processCurationAction.
fn finalize_payload(a: &abi::polaris_music::actions::Finalize) -> (String, String) {
    hashed(serde_json::json!({ "tx_hash": a.tx_hash }))
}

/// @see processLikeAction.
fn like_payload(a: &abi::polaris_music::actions::Like) -> (String, String) {
    hashed(serde_json::json!({
        "account": a.account,
        "node_id": a.node_id,
        "node_path": a.node_path,
    }))
}

/// @see processLikeAction.
fn unlike_payload(a: &abi::polaris_music::actions::Unlike) -> (String, String) {
    hashed(serde_json::json!({
        "account": a.account,
        "node_id": a.node_id,
    }))
}

#[substreams::handlers::map]
fn map_anchored_events(params: String, actions: ActionTraces) -> Result<AnchoredEvents, Error> {
    use sha2::{Digest, Sha256};

    let contract_account = contract_account_from_params(&params);

    let anchored_events: Vec<AnchoredEvent> = actions
        .action_traces
        .iter()
        .filter_map(|action_trace| {
            // filtered_actions has already applied the `code:` query server-side.
            // Kept anyway: the params could name a different account than the
            // filter query if someone sets them independently, and a feed
            // carrying another contract's actions would be worse than an empty one.
            if action_trace.receiver != contract_account {
                return None;
            }

            let action = action_trace.action.as_ref()?;

            // Block and transaction identity travel on the trace itself
            // (sf.antelope.type.v1.ActionTrace), so nothing is lost by no longer
            // receiving the enclosing Block.
            let block_num = action_trace.block_num;
            let block_id = &action_trace.producer_block_id;
            let block_timestamp = action_trace
                .block_time
                .as_ref()
                .map(|t| t.seconds as u64)
                .unwrap_or(0);

            // Filter actions we care about for ingestion
            match action.name.as_str() {
                // like/unlike joined this list when the contract stopped
                // writing the likes table: the trace is now the only record of
                // what an account liked, and the backend projects it.
                "put" | "vote" | "finalize" | "like" | "unlike" => {}
                _ => return None,
            }

            // Extract JSON payload and content hash
            let (json_data, content_hash) = if !action.json_data.is_empty() {
                // Path 1: json_data available (preferred path from Firehose)
                let json_str = &action.json_data;

                let content_hash = if action.name == "put" {
                    // In 0.6, Checksum256 fields are already hex strings
                    match serde_json::from_str::<serde_json::Value>(json_str) {
                        Ok(val) => val
                            .get("hash")
                            .and_then(|h| h.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| {
                                let mut hasher = Sha256::new();
                                hasher.update(json_str.as_bytes());
                                hex::encode(hasher.finalize())
                            }),
                        Err(_) => {
                            log::info!("Failed to parse put action JSON for content_hash");
                            let mut hasher = Sha256::new();
                            hasher.update(json_str.as_bytes());
                            hex::encode(hasher.finalize())
                        }
                    }
                } else {
                    // For non-put actions, hash the JSON payload
                    let mut hasher = Sha256::new();
                    hasher.update(json_str.as_bytes());
                    hex::encode(hasher.finalize())
                };

                (json_str.clone(), content_hash)
            } else {
                // Path 2: json_data missing — decode raw_data with the embedded ABI.
                //
                // json_data is Firehose's decoding, done with whatever ABI it
                // has cached for the account. Every other action used to be
                // dropped here with only an info log, which meant an ABI cache
                // that had not caught up with a redeploy silently lost votes:
                // the action is real and irreversible on chain, and invisible
                // to the indexer. Adding the `memo` argument to vote() is
                // exactly the kind of change that opens such a gap.
                //
                // The package embeds its own ABI, so there is no reason to
                // depend on Firehose's for actions we already have bindings for.
                let decoded = decode_action_payload(action_trace, &action.name);

                let Some((json_str, content_hash)) = decoded else {
                    // substreams::log offers info and debug only, so this is as
                    // loud as it gets — but it now names the action and says it
                    // was dropped, where the old line said "non-put" and read
                    // like a deliberate skip rather than a loss.
                    log::info!(
                        "Could not decode {} from raw_data; skipping",
                        action.name
                    );
                    return None;
                };

                log::info!(
                    "Decoded {} from raw bytes: hash={}",
                    action.name,
                    &content_hash[..content_hash.len().min(12)]
                );

                (json_str, content_hash)
            };

            // Compute event hash from action payload (for debugging/trace identity)
            let mut hasher = Sha256::new();
            hasher.update(json_data.as_bytes());
            let event_hash = hex::encode(hasher.finalize());

            Some(AnchoredEvent {
                content_hash,
                event_hash,
                payload: json_data.into_bytes(),
                block_num,
                block_id: block_id.clone(),
                trx_id: action_trace.transaction_id.clone(),
                action_ordinal: action_trace.execution_index as u32,
                timestamp: block_timestamp,
                source: "substreams-eos".to_string(),
                contract_account: contract_account.to_string(),
                action_name: action.name.clone(),
            })
        })
        .collect();

    log::info!(
        "Extracted {} anchored events from {} filtered actions",
        anchored_events.len(),
        actions.action_traces.len()
    );

    Ok(AnchoredEvents {
        events: anchored_events,
    })
}

/// Store module: Aggregate statistics from events
///
/// PERF-05: Uses if-let chains instead of nested match for cleaner, branchless flow.
#[substreams::handlers::store]
fn store_stats(events: Events, store: StoreAddInt64) {
    for event in &events.events {
        store.add(0, "total_events", 1);

        if let Some(EventData {
            event: Some(ref data),
        }) = event.data
        {
            match data {
                pb::polaris::v1::event_data::Event::Put(_) => {
                    store.add(0, "total_puts", 1);
                }
                pb::polaris::v1::event_data::Event::Vote(_) => {
                    store.add(0, "total_votes", 1);
                }
                pb::polaris::v1::event_data::Event::Stake(_) => {
                    store.add(0, "total_stakes", 1);
                }
                pb::polaris::v1::event_data::Event::Like(_) => {
                    store.add(0, "total_likes", 1);
                }
                _ => {}
            }
        }
    }
}

/// Store module: Track per-account activity
///
/// PERF-05: Uses into_iter() for ownership transfer, avoids temporary String allocations
/// where possible. Fixed from StoreAdd trait to concrete StoreAddInt64.
#[substreams::handlers::store]
fn store_account_activity(events: Events, store: StoreAddInt64) {
    for event in &events.events {
        if let Some(EventData {
            event: Some(ref data),
        }) = event.data
        {
            let account_key = match data {
                pb::polaris::v1::event_data::Event::Put(e) => Some(&e.author),
                pb::polaris::v1::event_data::Event::Vote(e) => Some(&e.voter),
                pb::polaris::v1::event_data::Event::Stake(e) => Some(&e.account),
                pb::polaris::v1::event_data::Event::Like(e) => Some(&e.account),
                _ => None,
            };

            if let Some(account) = account_key {
                store.add(0, format!("account:{}:events", account), 1);
                store.add(
                    0,
                    format!("account:{}:last_block", account),
                    event.block_num as i64,
                );
            }
        }
    }
}

/// Map module: Output aggregated statistics
#[substreams::handlers::map]
fn map_stats(store: StoreGetInt64) -> Result<Stats, Error> {
    Ok(Stats {
        total_events: store.get_last("total_events").unwrap_or(0) as u64,
        total_puts: store.get_last("total_puts").unwrap_or(0) as u64,
        total_votes: store.get_last("total_votes").unwrap_or(0) as u64,
        total_stakes: store.get_last("total_stakes").unwrap_or(0) as u64,
        total_likes: store.get_last("total_likes").unwrap_or(0) as u64,
        unique_contributors: 0,
        total_staked_amount: "0.0000 MUS".to_string(),
    })
}

// ============ EVENT EXTRACTION FUNCTIONS ============
// PERF-05: Use Action::decode() trait method for type-safe deserialization.
// Pre-computed block_num/timestamp passed as args to avoid redundant lookups.

#[inline]
fn extract_put_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Put;

    let put = Put::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "PUT".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Put(PutEvent {
                author: put.author,
                // pb field is `r#type` (proto `type` is a Rust keyword);
                // `put` is the abigen struct, which spells it `type_`.
                r#type: put.type_ as u32,
                hash: put.hash,
                parent: put.parent,
                ts: put.ts as u64,
                tags: put.tags,
                expires_at: 0,
            })),
        }),
    })
}

#[inline]
fn extract_attest_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Attest;

    let attest = Attest::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "ATTEST".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Attest(AttestEvent {
                attestor: attest.attestor,
                tx_hash: attest.tx_hash,
                confirmed_type: attest.confirmed_type as u32,
            })),
        }),
    })
}

#[inline]
fn extract_vote_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Vote;

    let vote = Vote::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "VOTE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Vote(VoteEvent {
                voter: vote.voter,
                tx_hash: vote.tx_hash,
                val: vote.val as i32,
                weight: 0, // Not in action data - would need table lookup
            })),
        }),
    })
}

#[inline]
fn extract_finalize_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Finalize;

    let finalize = Finalize::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "FINALIZE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Finalize(FinalizeEvent {
                tx_hash: finalize.tx_hash,
                accepted: false,
                approval_percent: 0,
                reward_amount: 0,
            })),
        }),
    })
}

#[inline]
fn extract_stake_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Stake;

    let stake = Stake::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "STAKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Stake(StakeEvent {
                account: stake.account,
                node_id: stake.node_id,
                quantity: stake.quantity,
            })),
        }),
    })
}

#[inline]
fn extract_unstake_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Unstake;

    let unstake = Unstake::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "UNSTAKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Unstake(UnstakeEvent {
                account: unstake.account,
                node_id: unstake.node_id,
                quantity: unstake.quantity,
            })),
        }),
    })
}

#[inline]
fn extract_like_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Like;

    let like = Like::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "LIKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Like(LikeEvent {
                account: like.account,
                node_id: like.node_id,
                path: like.node_path,
            })),
        }),
    })
}

#[inline]
fn extract_unlike_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Unlike;

    let unlike = Unlike::decode(action_trace).ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "UNLIKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Unlike(UnlikeEvent {
                account: unlike.account,
                node_id: unlike.node_id,
            })),
        }),
    })
}

#[inline]
fn extract_update_respect_event(
    tx_hash: &str,
    block_num: u64,
    timestamp: u64,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Updrespect;

    let update = Updrespect::decode(action_trace).ok()?;

    let updates = update
        .respect_data
        .iter()
        .map(|pair| RespectUpdate {
            account: pair.key.clone(),
            respect: pair.value,
        })
        .collect();

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num,
        timestamp,
        event_type: "UPDATE_RESPECT".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::UpdateRespect(
                UpdateRespectEvent {
                    updates,
                    election_round: update.election_round,
                },
            )),
        }),
    })
}

#[cfg(test)]
mod payload_tests {
    use super::*;
    use abi::polaris_music::actions;

    /// These payloads are what the backend destructures by name, so a renamed
    /// or dropped field is a silent data loss rather than an error: ingestion.js
    /// reads `actionData.memo` and gets undefined, and the curator's reason is
    /// gone with nothing to show for it.
    ///
    /// The path they cover exists because Firehose's json_data is decoded with
    /// whatever ABI it has cached for the account. A redeploy that changes an
    /// action's arguments — adding `memo` to vote(), say — can leave that stale,
    /// and every non-put action used to be dropped outright in that case.

    fn parse(json: &str) -> serde_json::Value {
        serde_json::from_str(json).expect("payload is valid JSON")
    }

    #[test]
    fn a_vote_carries_its_memo() {
        let (json, _) = vote_payload(&actions::Vote {
            voter: "polaristest2".into(),
            tx_hash: "d1df34de".into(),
            val: -1,
            memo: "Track Listing is incorrect".into(),
        });

        let v = parse(&json);
        assert_eq!(v["voter"], "polaristest2");
        assert_eq!(v["tx_hash"], "d1df34de");
        assert_eq!(v["val"], -1);
        assert_eq!(v["memo"], "Track Listing is incorrect");
    }

    #[test]
    fn an_empty_memo_is_still_present() {
        // Absent and empty must stay distinguishable downstream: recordVote
        // stores null for an empty string, which is how "no comment given"
        // is told from "commented".
        let (json, _) = vote_payload(&actions::Vote {
            voter: "alice".into(),
            tx_hash: "abc".into(),
            val: 1,
            memo: String::new(),
        });

        assert_eq!(parse(&json)["memo"], "");
    }

    #[test]
    fn a_cleared_vote_keeps_its_value() {
        // val 0 withdraws a vote. A payload that dropped it would read as an
        // upvote or as nothing at all.
        let (json, _) = vote_payload(&actions::Vote {
            voter: "alice".into(), tx_hash: "abc".into(), val: 0, memo: "changed my mind".into(),
        });

        assert_eq!(parse(&json)["val"], 0);
    }

    #[test]
    fn finalize_carries_the_hash_it_finalizes() {
        let (json, _) = finalize_payload(&actions::Finalize { tx_hash: "36407f14".into() });
        assert_eq!(parse(&json)["tx_hash"], "36407f14");
    }

    #[test]
    fn a_like_carries_its_path() {
        // The path is the whole point of a like — it is what the graph walks.
        let (json, _) = like_payload(&actions::Like {
            account: "alice".into(),
            node_id: "node1".into(),
            node_path: vec!["a".into(), "b".into()],
        });

        let v = parse(&json);
        assert_eq!(v["account"], "alice");
        assert_eq!(v["node_id"], "node1");
        assert_eq!(v["node_path"][1], "b");
    }

    #[test]
    fn an_unlike_needs_no_path() {
        let (json, _) = unlike_payload(&actions::Unlike {
            account: "alice".into(), node_id: "node1".into(),
        });

        let v = parse(&json);
        assert_eq!(v["account"], "alice");
        assert!(v.get("node_path").is_none());
    }

    #[test]
    fn put_is_keyed_by_its_own_hash_not_a_digest() {
        // put carries the content hash the whole system keys on; hashing the
        // payload instead would produce an id nothing else recognizes.
        let a = actions::Put {
            author: "polaristests".into(),
            type_: 21,
            hash: "36407f14383b".into(),
            event_cid: "bafk".into(),
            parent: String::new(),
            ts: 1787608853,
            tags: vec![],
        };
        let (json, content_hash) = put_payload(&a);

        assert_eq!(content_hash, "36407f14383b");
        assert_eq!(parse(&json)["type"], 21);
    }

    #[test]
    fn hashing_is_stable_and_content_dependent() {
        // The backend dedups on this, so identical actions must agree and
        // different ones must not.
        let one = vote_payload(&actions::Vote {
            voter: "a".into(), tx_hash: "h".into(), val: 1, memo: "x".into() }).1;
        let same = vote_payload(&actions::Vote {
            voter: "a".into(), tx_hash: "h".into(), val: 1, memo: "x".into() }).1;
        let other = vote_payload(&actions::Vote {
            voter: "a".into(), tx_hash: "h".into(), val: 1, memo: "y".into() }).1;

        assert_eq!(one, same);
        assert_ne!(one, other);
        assert_eq!(one.len(), 64);
    }
}

#[cfg(test)]
mod tests {
    use super::contract_account_from_params;

    // These params now double as the blockFilter query, so a parse that returns
    // the wrong account does not error — it silently matches no action and the
    // chain looks quiet. Worth pinning precisely for that reason.

    #[test]
    fn a_bare_account_is_still_accepted() {
        // What every existing deployment passes today.
        assert_eq!(contract_account_from_params("polarismusic"), "polarismusic");
    }

    #[test]
    fn a_code_term_yields_the_account() {
        assert_eq!(contract_account_from_params("code:polarismusic"), "polarismusic");
    }

    #[test]
    fn a_code_term_is_found_among_others() {
        assert_eq!(
            contract_account_from_params("code:polarismusic && action:put"),
            "polarismusic"
        );
        assert_eq!(
            contract_account_from_params("action:put && code:polarismusic"),
            "polarismusic"
        );
    }

    #[test]
    fn parentheses_and_spacing_do_not_defeat_the_match() {
        assert_eq!(
            contract_account_from_params("(code:polarismusic || code:polaristoken)"),
            "polarismusic"
        );
        assert_eq!(contract_account_from_params("  code: polarismusic  "), "polarismusic");
    }

    #[test]
    fn empty_params_fall_back_to_the_default() {
        assert_eq!(contract_account_from_params(""), "polaris");
        assert_eq!(contract_account_from_params("   "), "polaris");
    }

    #[test]
    fn an_empty_code_term_does_not_yield_an_empty_account() {
        // An empty account would match no receiver at all. Falling back to the
        // literal is wrong too, but it is visibly wrong rather than quietly so.
        assert_eq!(contract_account_from_params("code:"), "code:");
    }

    #[test]
    fn a_query_without_a_code_term_is_treated_as_a_bare_name() {
        assert_eq!(contract_account_from_params("action:put"), "action:put");
    }
}
