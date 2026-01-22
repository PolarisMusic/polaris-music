/**
 * Polaris Music Contract ABI
 * Minimal ABI definition for the put action
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
        }
    ],
    actions: [
        {
            name: 'put',
            type: 'put',
            ricardian_contract: ''
        }
    ],
    tables: [],
    ricardian_clauses: [],
    error_messages: [],
    abi_extensions: [],
    variants: []
};
