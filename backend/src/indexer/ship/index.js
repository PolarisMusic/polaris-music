/**
 * @fileoverview SHiP (State History Plugin) Fallback Ingestion Module
 *
 * Provides real blockchain event ingestion via Antelope's state_history_plugin
 * as a fallback to the primary Substreams path.
 *
 * Components:
 * - ShipClient: WebSocket transport with reconnect and flow control
 * - ShipProtocol: Binary protocol encode/decode using SHiP ABI
 * - ShipAbiRegistry: Contract ABI cache for action data decoding
 * - ShipEventSource: Action filtering and canonical AnchoredEvent emission
 */

export { ShipClient } from './shipClient.js';
export { ShipProtocol } from './shipProtocol.js';
export { ShipAbiRegistry } from './shipAbiRegistry.js';
export { ShipEventSource } from './shipEventSource.js';
