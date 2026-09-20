import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeKeyError, parseIsoDuration } from '../src/sources/youtube.ts';

test('parses the ISO-8601 durations the API actually returns', () => {
  assert.equal(parseIsoDuration('PT3M45S'), 225);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT10M'), 600);
  assert.equal(parseIsoDuration('PT1H'), 3600);
});

test('a malformed or missing duration yields zero rather than NaN', () => {
  // NaN here would poison the played-fraction maths and corrupt training data.
  assert.equal(parseIsoDuration(undefined), 0);
  assert.equal(parseIsoDuration(''), 0);
  assert.equal(parseIsoDuration('not a duration'), 0);
  assert.equal(parseIsoDuration('P1Y'), 0);
});

/*
 * Error bodies below are the real ones, taken from live responses — an invalid
 * key answers 400 with API_KEY_INVALID under error.details, while the 403s put
 * their reason under error.errors.
 */

test('a key failure explains itself and says what to fix', () => {
  const invalid = describeKeyError(400, {
    error: {
      code: 400,
      message: 'API key not valid. Please pass a valid API key.',
      errors: [{ message: 'API key not valid.', domain: 'global', reason: 'badRequest' }],
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
    },
  });
  assert.match(invalid, /not valid/i);

  const notEnabled = describeKeyError(403, {
    error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] },
  });
  assert.match(notEnabled, /not enabled/i);
  assert.match(notEnabled, /Cloud console/i);

  const referer = describeKeyError(403, {
    error: { code: 403, errors: [{ reason: 'ipRefererBlocked' }] },
  });
  assert.match(referer, /restricted/i);

  const quota = describeKeyError(403, {
    error: { code: 403, errors: [{ reason: 'quotaExceeded' }] },
  });
  assert.match(quota, /quota/i);
  assert.match(quota, /10,000/);
});

test('an unrecognised failure still says something true', () => {
  assert.match(describeKeyError(500, { error: { message: 'Backend error' } }), /Backend error/);
  assert.equal(describeKeyError(0, null), 'Could not reach the YouTube API — check the connection.');
});
