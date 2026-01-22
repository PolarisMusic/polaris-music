/**
 * @fileoverview ReleaseBundle Schema Validation
 *
 * Validates ReleaseBundle objects against the canonical JSON Schema.
 * This validation ensures data integrity at ingress points (API, event processor).
 *
 * Architecture:
 * 1. Frontend submits data (may use legacy field names)
 * 2. normalizeReleaseBundle() converts legacy → canonical
 * 3. validateReleaseBundle() ensures canonical shape is correct
 * 4. Graph ingestion processes validated canonical bundle
 *
 * @module schema/validateReleaseBundle
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load JSON Schema
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = join(__dirname, 'releaseBundle.schema.json');
const releaseBundleSchema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

// Initialize AJV with formats (for URI validation)
const ajv = new Ajv({
    allErrors: true,  // Collect all errors, not just first
    verbose: true,     // Include schema and data in errors
    strict: false      // Allow $schema and $id keywords
});
addFormats(ajv);

// Compile schema for better performance
const validate = ajv.compile(releaseBundleSchema);

/**
 * Validate a ReleaseBundle against canonical schema
 *
 * @param {Object} bundle - ReleaseBundle to validate (should be in canonical format)
 * @returns {{valid: boolean, errors?: string[]}} Validation result with actionable errors
 *
 * @example
 * const result = validateReleaseBundle(canonicalBundle);
 * if (!result.valid) {
 *   console.error('Validation failed:', result.errors);
 * }
 */
export function validateReleaseBundle(bundle) {
    const isValid = validate(bundle);

    if (isValid) {
        return { valid: true };
    }

    // Transform AJV errors into actionable messages
    const errors = validate.errors.map(err => {
        const path = err.instancePath || 'root';
        const property = path.replace(/^\//, '').replace(/\//g, '.');

        switch (err.keyword) {
            case 'required':
                return `${property || 'root'}: Missing required field '${err.params.missingProperty}'`;

            case 'type':
                return `${property}: Must be ${err.params.type}, got ${typeof err.data}`;

            case 'minLength':
                return `${property}: Must be at least ${err.params.limit} characters`;

            case 'minItems':
                return `${property}: Must have at least ${err.params.limit} item(s)`;

            case 'additionalProperties':
                return `${property}: Unknown field '${err.params.additionalProperty}' (not in canonical schema)`;

            case 'format':
                return `${property}: Must be valid ${err.params.format} format`;

            case 'minimum':
            case 'maximum':
                return `${property}: Value ${err.data} is out of range`;

            default:
                return `${property}: ${err.message}`;
        }
    });

    return {
        valid: false,
        errors
    };
}

/**
 * Validate ReleaseBundle and throw if invalid
 *
 * @param {Object} bundle - ReleaseBundle to validate
 * @throws {Error} Validation error with detailed messages
 *
 * @example
 * try {
 *   validateReleaseBundleOrThrow(bundle);
 *   // Bundle is valid, proceed with processing
 * } catch (err) {
 *   console.error('Invalid bundle:', err.message);
 * }
 */
export function validateReleaseBundleOrThrow(bundle) {
    const result = validateReleaseBundle(bundle);

    if (!result.valid) {
        const errorMessage = [
            'ReleaseBundle validation failed (canonical schema):',
            ...result.errors.map(e => `  - ${e}`)
        ].join('\n');

        throw new Error(errorMessage);
    }
}

export default validateReleaseBundle;
