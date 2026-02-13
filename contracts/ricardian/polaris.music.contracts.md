# Polaris Music Registry - Smart Contract Actions

## put

**Description:** Anchor an off-chain music event on the blockchain.

**Intent:** This action creates an immutable on-chain record of a music data event. The full event data is stored off-chain (IPFS/S3), with only its SHA256 hash anchored on-chain for efficiency and immutability.

**Inputs:**
- `author`: The blockchain account submitting the event
- `type`: Event type code (21=RELEASE_BUNDLE, 30=ADD_CLAIM, 31=EDIT_CLAIM, 40=VOTE, 41=LIKE, 42=DISCUSS, 50=FINALIZE, 60=MERGE_NODE)
- `hash`: SHA256 hash of the canonical off-chain event body
- `parent`: Optional parent event hash for threading discussions
- `ts`: Unix timestamp when event was created
- `tags`: Searchable tags for discovery (max 10)

**Consequences:**
- The event hash is permanently recorded on-chain
- A voting window opens for community review
- RAM costs are charged to the submitter
- Event becomes eligible for rewards after voting completes

---

## attest

**Description:** Attest to the validity of a high-value submission.

**Intent:** Provide expert verification that a submission (like a release bundle) contains accurate information and proper formatting.

**Inputs:**
- `attestor`: Account providing attestation (must be authorized)
- `tx_hash`: Hash of the event being attested
- `confirmed_type`: Event type being confirmed

**Consequences:**
- Attestation is recorded on-chain
- Event becomes eligible for finalization
- Attestor's reputation is associated with the submission

---

## vote

**Description:** Cast a Respect-weighted vote on an anchored event.

**Intent:** Allow community members to approve or reject submissions based on accuracy and quality. Vote weight is determined by Fractally Respect values.

**Inputs:**
- `voter`: Account casting the vote
- `tx_hash`: Hash of the event being voted on
- `val`: Vote value (+1=approve, -1=reject, 0=neutral/unvote)

**Consequences:**
- Vote is recorded with current Respect weight
- Vote can be changed during voting window
- Vote influences finalization outcome and reward distribution

---

## finalize

**Description:** Finalize voting and distribute rewards after voting window closes.

**Intent:** Complete the voting process, determine acceptance/rejection, and distribute token rewards according to the emission curve.

**Inputs:**
- `tx_hash`: Hash of the event to finalize

**Consequences:**
- Voting is permanently closed for this event
- Tokens are distributed based on acceptance (≥90% approval)
- If accepted: 50% to submitter, 50% to voters
- If rejected: 50% to voters, 50% to stakers

---

## stake

**Description:** Stake MUS tokens on a music entity (Group, Person, Track, etc.).

**Intent:** Show support for an entity and participate in reward distribution for rejected submissions.

**Inputs:**
- `account`: Account doing the staking
- `node_id`: SHA256 identifier of entity being staked on
- `quantity`: Amount of MUS tokens to stake

**Consequences:**
- Tokens are locked in the contract
- Stake earns portion of rejected submission rewards
- Stake increases visibility of the entity

---

## unstake

**Description:** Remove staked tokens from a music entity.

**Intent:** Withdraw previously staked tokens.

**Inputs:**
- `account`: Account removing stake
- `node_id`: Node to unstake from
- `quantity`: Amount to unstake

**Consequences:**
- Tokens are returned to account
- Future rewards are reduced proportionally
- If all stake removed, account is removed from stakers list

---

## like

**Description:** Like a music entity with path tracking.

**Intent:** Express appreciation for an entity while recording the discovery path through the graph.

**Inputs:**
- `account`: Account doing the liking
- `node_id`: SHA256 identifier of entity being liked
- `node_path`: Path through graph nodes leading to this entity

**Consequences:**
- Like is recorded with discovery path
- Path data helps understand music discovery patterns
- Like count for entity increases

---

## unlike

**Description:** Remove a previously created like.

**Intent:** Withdraw appreciation for an entity.

**Inputs:**
- `account`: Account removing the like
- `node_id`: Node being unliked

**Consequences:**
- Like record is removed
- Like count for entity decreases

---

## updrespect

**Description:** Update Respect values from Fractally elections.

**Intent:** Synchronize voting weights with Fractally consensus results.

**Inputs:**
- `respect_data`: Array of account:respect pairs
- `election_round`: Fractally round number

**Consequences:**
- Respect values updated for all accounts
- Vote weights updated for future votes
- Round number recorded for verification

**Authorization:** Only the designated Fractally oracle can call this action.

---

## setoracle

**Description:** Set the authorized Fractally oracle account.

**Intent:** Configure which account can update Respect values.

**Inputs:**
- `oracle`: Account authorized to update Respect

**Consequences:**
- Oracle account is updated in global state

**Authorization:** Only the contract account can call this action.

---

## init

**Description:** Initialize contract state.

**Intent:** Set up initial configuration for the contract.

**Inputs:**
- `oracle`: Initial Fractally oracle account
- `token_contract`: Token contract for MUS token

**Consequences:**
- Global state is initialized
- Contract is ready for use

**Authorization:** Only the contract account can call this action. Can only be called once.

---

## clear

**Description:** Clear all contract data.

**Intent:** Reset contract state for testing purposes.

**Consequences:**
- All tables are emptied
- Global state is removed
- **WARNING:** This action should be removed before mainnet deployment

**Authorization:** Only the contract account can call this action.
