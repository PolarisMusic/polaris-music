mod abi;
mod pb;

use substreams::errors::Error;
use substreams::log;
use substreams::prelude::*;
use substreams::store::{StoreAddInt64, StoreGetInt64};
use substreams_antelope::pb::Block;
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
#[substreams::handlers::map]
fn map_anchored_events(params: String, block: Block) -> Result<AnchoredEvents, Error> {
    use sha2::{Digest, Sha256};

    let contract_account = if params.is_empty() {
        "polaris"
    } else {
        &params
    };

    // Pre-compute block-level values once (PERF-05: avoid recomputing per action)
    let block_id = &block.id;
    let block_num = block.number as u64;
    let block_timestamp = block
        .header
        .as_ref()
        .and_then(|h| h.timestamp.as_ref())
        .map(|t| t.seconds as u64)
        .unwrap_or(0);

    // PERF-05: Use block.action_traces() iterator with filter_map for streaming
    let anchored_events: Vec<AnchoredEvent> = block
        .action_traces()
        .filter_map(|(action_trace, trx)| {
            // Only process actions received by our contract
            if action_trace.receiver != contract_account {
                return None;
            }

            let action = action_trace.action.as_ref()?;

            // Filter actions we care about for ingestion
            match action.name.as_str() {
                "put" | "vote" | "finalize" => {}
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
                // Path 2: json_data missing - use raw_data with embedded ABI
                if action.name != "put" {
                    log::info!(
                        "Skipping non-put action without json_data: {}",
                        action.name
                    );
                    return None;
                }

                // Decode Put action from raw bytes using ABI bindings
                let put_action = match abi::polaris_music::actions::Put::decode(action_trace) {
                    Ok(put) => put,
                    Err(e) => {
                        log::info!(
                            "Failed to decode put action: {:?}",
                            e
                        );
                        return None;
                    }
                };

                // In 0.6, hash is already a hex string (Checksum256 = String)
                let content_hash = put_action.hash.clone();

                // Construct canonical JSON payload for backend ingestion
                let json_payload = serde_json::json!({
                    "author": put_action.author,
                    "type": put_action.type_,
                    "hash": &put_action.hash,
                    "event_cid": put_action.event_cid,
                    "parent": put_action.parent,
                    "ts": put_action.ts,
                    "tags": put_action.tags,
                });

                let json_str = json_payload.to_string();

                log::info!(
                    "Decoded put from raw bytes: hash={}, author={}",
                    &content_hash[..content_hash.len().min(12)],
                    put_action.author
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
                trx_id: trx.id.clone(),
                action_ordinal: action_trace.execution_index as u32,
                timestamp: block_timestamp,
                source: "substreams-eos".to_string(),
                contract_account: contract_account.to_string(),
                action_name: action.name.clone(),
            })
        })
        .collect();

    log::info!(
        "Extracted {} anchored events from block {}",
        anchored_events.len(),
        block.number
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
                type_: put.type_ as u32,
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
            event: Some(pb::polaris::v1::event_data::Event::Updrespect(
                UpdateRespectEvent {
                    updates,
                    election_round: update.election_round,
                },
            )),
        }),
    })
}
