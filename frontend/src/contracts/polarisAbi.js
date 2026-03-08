/**
 * Polaris Music Contract ABI
 *
 * Local ABI definition used in dev/test mode (USE_LOCAL_ABI=true).
 * Must include every action struct the frontend submits: put, like, vote.
 *
 * Keep in sync with contracts/polaris.music.cpp action signatures.
 */

export const POLARIS_ABI = {
    version: 'eosio::abi/1.2',
    types: [],
    structs: [
        {
            name: 'put',
            base: '',
            fields: [
                { name: 'author', type: 'name' },
                { name: 'type', type: 'uint8' },
                { name: 'hash', type: 'checksum256' },
                { name: 'event_cid', type: 'string' },
                { name: 'parent', type: 'checksum256?' },
                { name: 'ts', type: 'uint32' },
                { name: 'tags', type: 'name[]' }
            ]
        },
        {
            name: 'like',
            base: '',
            fields: [
                { name: 'account', type: 'name' },
                { name: 'node_id', type: 'checksum256' },
                { name: 'node_path', type: 'checksum256[]' }
            ]
        },
        {
            name: 'vote',
            base: '',
            fields: [
                { name: 'voter', type: 'name' },
                { name: 'tx_hash', type: 'checksum256' },
                { name: 'val', type: 'int8' }
            ]
        }
    ],
    actions: [
        {
            name: 'put',
            type: 'put',
            ricardian_contract: ''
        },
        {
            name: 'like',
            type: 'like',
            ricardian_contract: ''
        },
        {
            name: 'vote',
            type: 'vote',
            ricardian_contract: ''
        }
    ],
    tables: [],
    ricardian_clauses: [],
    error_messages: [],
    abi_extensions: [],
    variants: []
};
