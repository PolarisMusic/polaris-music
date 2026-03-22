/**
 * @fileoverview Legacy SHiP Event Source Wrapper
 *
 * This file now re-exports from the real SHiP implementation at
 * backend/src/indexer/ship/shipEventSource.js
 *
 * The original stub has been replaced by a proper SHiP transport/protocol
 * stack that handles binary SHiP frames, ABI-based action decoding,
 * and canonical AnchoredEvent emission.
 *
 * For direct use of individual components, import from './ship/index.js':
 *   import { ShipClient, ShipProtocol, ShipAbiRegistry, ShipEventSource } from './ship/index.js';
 *
 * @deprecated Import from './ship/shipEventSource.js' instead
 */

export { ShipEventSource, ShipEventSource as default } from './ship/shipEventSource.js';
