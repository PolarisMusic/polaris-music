/**
 * @fileoverview SHiP (State History Plugin) Protocol Encoder/Decoder
 *
 * Handles the binary wire protocol used by Antelope's state_history_plugin.
 *
 * Protocol overview:
 * 1. On WebSocket connect, SHiP sends a JSON ABI defining its protocol types
 * 2. All subsequent messages are binary, encoded using that ABI
 * 3. Requests are encoded as the 'request' variant type
 * 4. Responses are decoded as the 'result' variant type
 *
 * Key protocol types:
 * - request: variant[get_status_request_v0, get_blocks_request_v0, get_blocks_ack_request_v0]
 * - result: variant[get_status_result_v0, get_blocks_result_v0]
 *
 * @module indexer/ship/shipProtocol
 */

import { ABI, Serializer } from '@wharfkit/antelope';

/**
 * SHiP Protocol handler.
 * Manages the protocol ABI and provides encode/decode methods.
 */
export class ShipProtocol {
    constructor() {
        /** @type {ABI|null} */
        this.abi = null;
        this.initialized = false;
    }

    /**
     * Initialize the protocol with the ABI received from SHiP on connection.
     * The first WebSocket message is always a JSON string containing the protocol ABI.
     *
     * @param {string} abiJson - JSON string of the SHiP protocol ABI
     */
    initialize(abiJson) {
        const abiDef = JSON.parse(abiJson);
        this.abi = ABI.from(abiDef);
        this.initialized = true;
    }

    /**
     * Ensure the protocol is initialized before use.
     */
    _ensureInitialized() {
        if (!this.initialized) {
            throw new Error('ShipProtocol not initialized. Call initialize() with the SHiP ABI first.');
        }
    }

    /**
     * Encode a request message to binary for sending to SHiP.
     *
     * @param {string} requestType - Request type name (e.g., 'get_blocks_request_v0')
     * @param {Object} requestData - Request data object
     * @returns {Uint8Array} Binary-encoded request
     */
    encodeRequest(requestType, requestData) {
        this._ensureInitialized();
        const encoded = Serializer.encode({
            type: 'request',
            abi: this.abi,
            object: [requestType, requestData],
        });
        return encoded.array;
    }

    /**
     * Encode a get_blocks_request_v0.
     *
     * @param {Object} options
     * @param {number} options.startBlock - Start block number
     * @param {number} options.endBlock - End block number (0xffffffff for unlimited)
     * @param {number} [options.maxMessagesInFlight=5] - Flow control window
     * @param {boolean} [options.irreversibleOnly=false] - Only stream irreversible blocks
     * @param {boolean} [options.fetchBlock=true] - Include block data
     * @param {boolean} [options.fetchTraces=true] - Include action traces
     * @param {boolean} [options.fetchDeltas=false] - Include table deltas
     * @returns {Uint8Array} Binary-encoded request
     */
    encodeGetBlocksRequest({
        startBlock,
        endBlock = 0xffffffff,
        maxMessagesInFlight = 5,
        irreversibleOnly = false,
        fetchBlock = true,
        fetchTraces = true,
        fetchDeltas = false,
    }) {
        return this.encodeRequest('get_blocks_request_v0', {
            start_block_num: startBlock,
            end_block_num: endBlock,
            max_messages_in_flight: maxMessagesInFlight,
            have_positions: [],
            irreversible_only: irreversibleOnly,
            fetch_block: fetchBlock,
            fetch_traces: fetchTraces,
            fetch_deltas: fetchDeltas,
        });
    }

    /**
     * Encode a get_blocks_ack_request_v0 (flow control acknowledgement).
     *
     * @param {number} numMessages - Number of messages to acknowledge
     * @returns {Uint8Array} Binary-encoded request
     */
    encodeAck(numMessages = 1) {
        return this.encodeRequest('get_blocks_ack_request_v0', {
            num_messages: numMessages,
        });
    }

    /**
     * Encode a get_status_request_v0.
     *
     * @returns {Uint8Array} Binary-encoded request
     */
    encodeGetStatusRequest() {
        return this.encodeRequest('get_status_request_v0', {});
    }

    /**
     * Decode a binary result message from SHiP.
     *
     * @param {Buffer|Uint8Array} data - Binary message data
     * @returns {Object} Decoded result with { type, data }
     */
    decodeResult(data) {
        this._ensureInitialized();

        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const decoded = Serializer.decode({
            type: 'result',
            abi: this.abi,
            data: bytes,
        });

        // The result is a variant: [typeName, data]
        // Serializer.decode returns it as a typed object or array
        return this._normalizeVariant(decoded);
    }

    /**
     * Normalize a decoded variant into a consistent { type, data } shape.
     * The Serializer may return variants in different formats.
     *
     * @param {*} decoded - Decoded variant value
     * @returns {{ type: string, data: Object }}
     */
    _normalizeVariant(decoded) {
        // If it's an array [typeName, data], normalize
        if (Array.isArray(decoded)) {
            return { type: decoded[0], data: Serializer.objectify(decoded[1]) };
        }

        // If it has a variant-like structure with first/second or value
        if (decoded && typeof decoded === 'object') {
            // Wharfkit variants have a value property and a variantIdx
            const obj = Serializer.objectify(decoded);
            if (Array.isArray(obj)) {
                return { type: obj[0], data: obj[1] };
            }
            return { type: 'unknown', data: obj };
        }

        return { type: 'unknown', data: decoded };
    }

    /**
     * Extract action traces from a decoded get_blocks_result_v0.
     *
     * The traces field is optional (nullable) and contains serialized trace data.
     * This method handles the nested binary decoding of traces.
     *
     * @param {Object} blockResult - Decoded get_blocks_result_v0 data
     * @returns {{ blockNum: number, blockId: string, timestamp: string, traces: Array }}
     */
    extractBlockData(blockResult) {
        const thisBlock = blockResult.this_block;
        if (!thisBlock) {
            return null;
        }

        const blockNum = Number(thisBlock.block_num);
        const blockId = String(thisBlock.block_id);

        // Block header may be optional
        let timestamp = null;
        if (blockResult.block) {
            // block is optional bytes - if present, it's a signed_block
            // We need to decode it from the protocol ABI
            try {
                const blockData = this._decodeOptionalBytes(blockResult.block, 'signed_block');
                if (blockData) {
                    timestamp = String(blockData.timestamp || blockData.header?.timestamp || '');
                }
            } catch {
                // Block decode failed - use null timestamp
            }
        }

        // Traces are optional bytes containing an array of transaction_trace
        let traces = [];
        if (blockResult.traces) {
            try {
                traces = this._decodeOptionalBytes(blockResult.traces, 'transaction_trace[]');
                if (!Array.isArray(traces)) {
                    traces = traces ? [traces] : [];
                }
                traces = traces.map(t => Serializer.objectify(t));
            } catch {
                // Trace decode failed
                traces = [];
            }
        }

        return {
            blockNum,
            blockId,
            timestamp,
            traces,
            lastIrreversible: blockResult.last_irreversible
                ? Number(blockResult.last_irreversible.block_num)
                : null,
        };
    }

    /**
     * Decode optional bytes field from a SHiP block result.
     * SHiP sends block/trace/delta data as optional<bytes> that need secondary decoding.
     *
     * @param {*} optionalBytes - The optional bytes value from the result
     * @param {string} typeName - The ABI type to decode as
     * @returns {*} Decoded value or null
     */
    _decodeOptionalBytes(optionalBytes, typeName) {
        if (!optionalBytes) return null;

        // Convert to Uint8Array if needed
        let bytes;
        if (optionalBytes instanceof Uint8Array) {
            bytes = optionalBytes;
        } else if (typeof optionalBytes === 'string') {
            // Hex string
            bytes = hexToUint8Array(optionalBytes);
        } else if (optionalBytes.array) {
            bytes = optionalBytes.array;
        } else if (Buffer.isBuffer(optionalBytes)) {
            bytes = new Uint8Array(optionalBytes);
        } else {
            return null;
        }

        if (bytes.length === 0) return null;

        return Serializer.decode({
            type: typeName,
            abi: this.abi,
            data: bytes,
        });
    }

    /**
     * Extract relevant action traces from transaction traces.
     * Filters for actions matching a specific contract account.
     *
     * @param {Array} transactionTraces - Array of decoded transaction_trace objects
     * @param {string} contractAccount - Contract account to filter for
     * @param {string[]} [actionNames] - Action names to filter for (default: all)
     * @returns {Array<{trxId: string, actionOrdinal: number, account: string, name: string, data: Uint8Array|string, receiver: string}>}
     */
    extractActionTraces(transactionTraces, contractAccount, actionNames = null) {
        const results = [];

        for (const txTrace of transactionTraces) {
            // Handle variant wrapper: transaction_trace may be ['transaction_trace_v0', data]
            const trace = Array.isArray(txTrace) ? txTrace[1] : txTrace;
            const trxId = String(trace.id || '');
            const actionTraces = trace.action_traces || [];

            for (let i = 0; i < actionTraces.length; i++) {
                // Each action_trace may also be a variant
                const actionTrace = Array.isArray(actionTraces[i])
                    ? actionTraces[i][1]
                    : actionTraces[i];

                const act = actionTrace.act;
                if (!act) continue;

                const account = String(act.account || '');
                const name = String(act.name || '');

                // Filter by contract account
                if (account !== contractAccount) continue;

                // Filter by action name if specified
                if (actionNames && !actionNames.includes(name)) continue;

                results.push({
                    trxId,
                    actionOrdinal: Number(actionTrace.action_ordinal ?? i),
                    receiver: String(actionTrace.receiver || account),
                    account,
                    name,
                    data: act.data, // Raw bytes - needs contract ABI to decode
                    authorization: act.authorization || [],
                });
            }
        }

        return results;
    }
}

/**
 * Convert a hex string to Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToUint8Array(hex) {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
    }
    return bytes;
}

export default ShipProtocol;
