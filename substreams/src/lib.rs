mod abi;
mod pb;

use anyhow::anyhow;
use substreams::errors::Error;
use substreams::log;
use substreams::prelude::*;
use substreams::store::{StoreAdd, StoreAddInt64, StoreGet, StoreGetInt64, StoreNew};
use substreams_antelope::pb::Block;

use pb::polaris::v1::{
    AccountActivities, AccountActivity, AttestEvent, Event, EventData, Events, FinalizeEvent,
    LikeEvent, PutEvent, RespectUpdate, StakeEvent, Stats, UnlikeEvent, UnstakeEvent,
    UpdateRespectEvent, VoteEvent,
};

/// Map module: Extract all Polaris Music Registry events from blocks
#[substreams::handlers::map]
fn map_events(params: String, block: Block) -> Result<Events, Error> {
    // Parse contract account from params (defaults to "polaris")
    let contract_account = if params.is_empty() {
        "polaris".to_string()
    } else {
        params
    };

    log::info!(
        "Processing block {} with {} transactions",
        block.number,
        block.transaction_traces.len()
    );

    let mut events = Vec::new();

    // Iterate through all transactions in the block
    for trx_trace in &block.transaction_traces {
        if trx_trace.receipt.is_none() {
            continue;
        }

        let tx_hash = hex::encode(&trx_trace.id);

        // Iterate through all action traces
        for action_trace in &trx_trace.action_traces {
            // Only process actions from our contract
            if action_trace.receiver != contract_account {
                continue;
            }

            // Process each action type
            match action_trace.action.as_ref() {
                Some(action) => {
                    let event_opt = match action.name.as_str() {
                        "put" => extract_put_event(&tx_hash, &block, action_trace),
                        "attest" => extract_attest_event(&tx_hash, &block, action_trace),
                        "vote" => extract_vote_event(&tx_hash, &block, action_trace),
                        "finalize" => extract_finalize_event(&tx_hash, &block, action_trace),
                        "stake" => extract_stake_event(&tx_hash, &block, action_trace),
                        "unstake" => extract_unstake_event(&tx_hash, &block, action_trace),
                        "like" => extract_like_event(&tx_hash, &block, action_trace),
                        "unlike" => extract_unlike_event(&tx_hash, &block, action_trace),
                        "updaterespect" => {
                            extract_update_respect_event(&tx_hash, &block, action_trace)
                        }
                        _ => None, // Ignore other actions (setoracle, init, etc.)
                    };

                    if let Some(event) = event_opt {
                        events.push(event);
                    }
                }
                None => continue,
            }
        }
    }

    log::info!("Extracted {} events from block {}", events.len(), block.number);

    Ok(Events { events })
}

/// Store module: Aggregate statistics from events
#[substreams::handlers::store]
fn store_stats(events: Events, store: StoreAddInt64) {
    for event in events.events {
        // Increment total events counter
        store.add(0, "total_events", 1);

        // Increment counters by event type
        match event.data {
            Some(EventData {
                event: Some(data), ..
            }) => match data {
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
            },
            _ => {}
        }
    }
}

/// Store module: Track per-account activity
#[substreams::handlers::store]
fn store_account_activity(events: Events, store: StoreAdd) {
    for event in events.events {
        if let Some(EventData {
            event: Some(data), ..
        }) = event.data
        {
            let account_key = match &data {
                pb::polaris::v1::event_data::Event::Put(e) => Some(format!("account:{}", e.author)),
                pb::polaris::v1::event_data::Event::Vote(e) => Some(format!("account:{}", e.voter)),
                pb::polaris::v1::event_data::Event::Stake(e) => {
                    Some(format!("account:{}", e.account))
                }
                pb::polaris::v1::event_data::Event::Like(e) => {
                    Some(format!("account:{}", e.account))
                }
                _ => None,
            };

            if let Some(key) = account_key {
                // This is a simplified version - in production you'd store full AccountActivity proto
                store.add(0, &format!("{}:events", key), 1);
                store.add(0, &format!("{}:last_block", key), event.block_num as i64);
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
        unique_contributors: 0, // Would need to track unique accounts separately
        total_staked_amount: "0.0000 MUS".to_string(), // Would need to aggregate from stake events
    })
}

// ============ EVENT EXTRACTION FUNCTIONS ============

fn extract_put_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Put;

    let action = action_trace.action.as_ref()?;
    let put: Put = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "PUT".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Put(PutEvent {
                author: put.author.to_string(),
                type_: put.r#type as u32,
                hash: hex::encode(put.hash),
                parent: put.parent.map(hex::encode).unwrap_or_default(),
                ts: put.ts as u64,
                tags: put.tags.iter().map(|t| t.to_string()).collect(),
                expires_at: 0, // Not available in action data
            })),
        }),
    })
}

fn extract_attest_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Attest;

    let action = action_trace.action.as_ref()?;
    let attest: Attest = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "ATTEST".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Attest(AttestEvent {
                attestor: attest.attestor.to_string(),
                tx_hash: hex::encode(attest.tx_hash),
                confirmed_type: attest.confirmed_type as u32,
            })),
        }),
    })
}

fn extract_vote_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Vote;

    let action = action_trace.action.as_ref()?;
    let vote: Vote = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "VOTE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Vote(VoteEvent {
                voter: vote.voter.to_string(),
                tx_hash: hex::encode(vote.tx_hash),
                val: vote.val as i32,
                weight: 0, // Not in action data - would need table lookup
            })),
        }),
    })
}

fn extract_finalize_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Finalize;

    let action = action_trace.action.as_ref()?;
    let finalize: Finalize = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "FINALIZE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Finalize(FinalizeEvent {
                tx_hash: hex::encode(finalize.tx_hash),
                accepted: false,        // Would need to check voting results
                approval_percent: 0,    // Would need to calculate from votes
                reward_amount: 0,       // Would need to check from inline actions
            })),
        }),
    })
}

fn extract_stake_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Stake;

    let action = action_trace.action.as_ref()?;
    let stake: Stake = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "STAKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Stake(StakeEvent {
                account: stake.account.to_string(),
                node_id: hex::encode(stake.node_id),
                quantity: stake.quantity.to_string(),
            })),
        }),
    })
}

fn extract_unstake_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Unstake;

    let action = action_trace.action.as_ref()?;
    let unstake: Unstake = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "UNSTAKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Unstake(UnstakeEvent {
                account: unstake.account.to_string(),
                node_id: hex::encode(unstake.node_id),
                quantity: unstake.quantity.to_string(),
            })),
        }),
    })
}

fn extract_like_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Like;

    let action = action_trace.action.as_ref()?;
    let like: Like = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "LIKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Like(LikeEvent {
                account: like.account.to_string(),
                node_id: hex::encode(&like.node_id),
                path: like.node_path.iter().map(hex::encode).collect(),
            })),
        }),
    })
}

fn extract_unlike_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Unlike;

    let action = action_trace.action.as_ref()?;
    let unlike: Unlike = action.json_data.as_ref()?.parse_json().ok()?;

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
        event_type: "UNLIKE".to_string(),
        data: Some(EventData {
            event: Some(pb::polaris::v1::event_data::Event::Unlike(UnlikeEvent {
                account: unlike.account.to_string(),
                node_id: hex::encode(&unlike.node_id),
            })),
        }),
    })
}

fn extract_update_respect_event(
    tx_hash: &str,
    block: &Block,
    action_trace: &substreams_antelope::pb::ActionTrace,
) -> Option<Event> {
    use abi::polaris_music::actions::Updaterespect;

    let action = action_trace.action.as_ref()?;
    let update: Updaterespect = action.json_data.as_ref()?.parse_json().ok()?;

    let updates = update
        .respect_data
        .iter()
        .map(|pair| RespectUpdate {
            account: pair.key.to_string(),
            respect: pair.value,
        })
        .collect();

    Some(Event {
        tx_hash: tx_hash.to_string(),
        block_num: block.number,
        timestamp: block.header.as_ref()?.timestamp.as_ref()?.seconds as u64,
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
