/**
 * Tests for sanitizeError() — the 5xx response shaper.
 *
 * Stage A audit confirmed no client parses error.message strings, so
 * what matters here is the response *shape*: in production the body
 * carries only a generic message + correlation id; in development the
 * body also carries diagnostic detail and a stack trace.
 */

import { sanitizeError } from '../../src/utils/errorSanitizer.js';

describe('sanitizeError', () => {
    describe('production (default) shape', () => {
        test('returns generic message + errorId, no leaked details', () => {
            const err = new Error('Neo4j connection refused at bolt://10.0.0.5');
            err.stack = 'Error: Neo4j ...\n    at /opt/app/secret/path.js:42';
            const body = sanitizeError(err, 'req-abc-123', { env: 'production' });
            expect(body).toEqual({
                error: 'Internal server error',
                errorId: 'req-abc-123',
            });
        });

        test('omits errorId when no requestId is given', () => {
            const body = sanitizeError(new Error('boom'), undefined, { env: 'production' });
            expect(body).toEqual({ error: 'Internal server error' });
        });

        test('includes success: false when requested (envelope shape)', () => {
            const body = sanitizeError(new Error('boom'), 'r1', { env: 'production', success: false });
            expect(body).toEqual({
                error: 'Internal server error',
                errorId: 'r1',
                success: false,
            });
        });

        test('honours custom user-facing message', () => {
            const body = sanitizeError(new Error('boom'), 'r1', {
                env: 'production',
                message: 'Service temporarily unavailable',
            });
            expect(body.error).toBe('Service temporarily unavailable');
        });

        test('does not include detail or stack', () => {
            const err = new Error('secret detail');
            const body = sanitizeError(err, 'r1', { env: 'production' });
            expect(body).not.toHaveProperty('detail');
            expect(body).not.toHaveProperty('stack');
        });
    });

    describe('development shape', () => {
        test('includes detail and stack', () => {
            const err = new Error('Neo4j connection refused');
            err.stack = 'Error: Neo4j ...\n    at line';
            const body = sanitizeError(err, 'r1', { env: 'development' });
            expect(body.error).toBe('Internal server error');
            expect(body.errorId).toBe('r1');
            expect(body.detail).toBe('Neo4j connection refused');
            expect(body.stack).toBe('Error: Neo4j ...\n    at line');
        });

        test('non-Error values are coerced via String()', () => {
            const body = sanitizeError('a bare string error', 'r1', { env: 'development' });
            expect(body.detail).toBe('a bare string error');
            expect(body).not.toHaveProperty('stack');
        });

        test('null/undefined error has no detail', () => {
            const body = sanitizeError(undefined, 'r1', { env: 'development' });
            expect(body).not.toHaveProperty('detail');
            expect(body).not.toHaveProperty('stack');
        });
    });

    test('reads NODE_ENV when env opt is not provided', () => {
        const original = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            const body = sanitizeError(new Error('x'), 'r1');
            expect(body).not.toHaveProperty('detail');

            process.env.NODE_ENV = 'development';
            const body2 = sanitizeError(new Error('x'), 'r1');
            expect(body2.detail).toBe('x');
        } finally {
            process.env.NODE_ENV = original;
        }
    });
});
