/**
 * Settings that arrive blank.
 *
 * Not a hypothetical: docker-compose.yml passes every optional setting as
 * `- FOO=${FOO:-}`, so an unset one reaches the container as an empty string
 * rather than as nothing. `??` reads that as configured, and two clients were
 * built with nothing where a default belonged — a blank Odesli API base, which
 * made `fetch` throw "Failed to parse URL" on every lookup, and a blank
 * MusicBrainz User-Agent, which is the one header they refuse outright.
 *
 * Both failed only in a container. Running the same code from .env with the
 * line commented out gives the default and looks perfectly healthy, which is
 * why this is a unit test rather than something a developer would notice.
 */

import { describe, test, expect } from '@jest/globals';
import { envSetting } from '../../src/utils/envSetting.js';

describe('envSetting', () => {
    test('a blank value is not a value', () => {
        expect(envSetting('', 'default')).toBe('default');
        expect(envSetting('   ', 'default')).toBe('default');
        expect(envSetting('\n', 'default')).toBe('default');
    });

    test('undefined and null fall through as well', () => {
        expect(envSetting(undefined, 'default')).toBe('default');
        expect(envSetting(null, 'default')).toBe('default');
        expect(envSetting(undefined, '', null, 'default')).toBe('default');
    });

    test('the first configured value wins, most specific first', () => {
        expect(envSetting('explicit', 'from env', 'default')).toBe('explicit');
        expect(envSetting(undefined, 'from env', 'default')).toBe('from env');
    });

    test('a configured value comes back trimmed', () => {
        // An API key pasted with a trailing newline is the same key, and a
        // credential that differs by one invisible character is a bad
        // afternoon.
        expect(envSetting('  key-with-space  ')).toBe('key-with-space');
        expect(envSetting('\tkey\n')).toBe('key');
    });

    test('nothing configured at all is an empty string, not undefined', () => {
        // Callers test it with Boolean() and interpolate it into URLs; undefined
        // would read as the string "undefined" in a template literal.
        expect(envSetting()).toBe('');
        expect(envSetting('', null, undefined)).toBe('');
    });

    test('it does not mistake a falsy-looking setting for a blank one', () => {
        expect(envSetting('0', 'default')).toBe('0');
        expect(envSetting('false', 'default')).toBe('false');
    });
});
