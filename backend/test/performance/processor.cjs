/**
 * Artillery processor for Polaris Music Registry load tests
 *
 * SAFETY: This processor checks NODE_ENV and refuses to run in production.
 * Load tests should only run against development/test environments with:
 * - DEV_SIGNER_PRIVATE_KEY set in API container
 * - REQUIRE_ACCOUNT_AUTH=false
 */

// Production safety check
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'FATAL: Artillery load tests cannot run in production environment. ' +
    'Set NODE_ENV=development or NODE_ENV=test to proceed.'
  );
}

/**
 * Generate unique IDs and create MINT_ENTITY event payload
 * Sets context.vars.mintEvent for use in prepare request
 */
function makeIds(context, events, done) {
  // Generate unique entity ID for this virtual user
  const entityId = `load_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // Create MINT_ENTITY event matching smoke_payloads/mint-entity.tmpl.json schema
  const mintEvent = {
    v: 1,
    type: 'MINT_ENTITY',
    created_at: new Date().toISOString(),
    parents: [],
    body: {
      entity_type: 'person',
      canonical_id: entityId,
      initial_claims: [],
      provenance: {
        submitter: 'artillery-load-test',
        source: 'load_test_harness'
      }
    }
  };

  // Store in context for use in Artillery scenario
  context.vars.mintEvent = mintEvent;
  context.vars.entityId = entityId;

  return done();
}

/**
 * Build signed event after dev-sign response
 * Merges mintEvent with signature and author_pubkey
 * Sets context.vars.signedMintEvent for use in create request
 */
function buildSignedEvent(context, events, done) {
  // Get the original mintEvent and captured signature fields
  const mintEvent = context.vars.mintEvent;
  const sig = context.vars.sig;
  const author_pubkey = context.vars.author_pubkey;

  // Merge signature fields into event
  const signedMintEvent = {
    ...mintEvent,
    sig,
    author_pubkey
  };

  context.vars.signedMintEvent = signedMintEvent;

  return done();
}

/**
 * Build anchored event payload after create response
 * Creates the payload object and JSON-stringifies it for ingestion
 * Sets context.vars.anchoredPayload for use in ingest request
 *
 * IMPORTANT: Backend ingestion expects payload to be a JSON string, not an object
 */
function buildAnchoredPayload(context, events, done) {
  // Get captured values from previous requests
  const hash = context.vars.hash;
  const event_cid = context.vars.event_cid;

  // Build payload object matching blockchain action format
  // Type 22 = MINT_ENTITY (see smoke_pipeline.sh)
  const payloadObject = {
    author: 'smoketest',
    type: 22,
    hash: hash,
    event_cid: event_cid,
    ts: Math.floor(Date.now() / 1000),
    tags: []
  };

  // CRITICAL: Stringify the payload - backend expects it as a JSON string
  context.vars.anchoredPayload = JSON.stringify(payloadObject);

  return done();
}

// Export functions for Artillery to call
module.exports = {
  makeIds,
  buildSignedEvent,
  buildAnchoredPayload
};
