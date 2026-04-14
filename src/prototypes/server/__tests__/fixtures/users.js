'use strict';

/**
 * User fixtures for integration tests.
 *
 * OWNER is the primary authenticated user whose audits are tested.
 * OTHER is a second user used to verify ownership-enforcement (403/404
 * when accessing another user's resources).
 *
 * makeToken() signs a JWT with the TEST_SECRET so the real jwt.verify()
 * path in the authorize middleware is exercised — no mock required.
 */

const jwt = require('jsonwebtoken');

/** Shared secret used by all test tokens. Set on process.env before app load. */
const TEST_SECRET = 'test-jwt-secret-for-unit-tests-only';

/**
 * Primary test user — owns all test audits.
 * Matches the shape of a row returned by the `users` table.
 */
const OWNER = {
  user_id:    '3f2a8c1d-4e5b-4f6a-8b9c-0d1e2f3a4b5c',
  email:      'alex.chen@accessibility-firm.com',
  first_name: 'Alex',
  last_name:  'Chen',
  role:       'general',
  created_at: '2024-11-01T09:15:22.000Z',
};

/**
 * Secondary test user — has no audits in the test data.
 * Used to verify that requests with a valid token for the wrong user
 * receive 404, not 200 or 403.
 */
const OTHER = {
  user_id:    '7a1b2c3d-8e9f-0a1b-2c3d-4e5f6a7b8c9d',
  email:      'morgan.lee@accessibility-firm.com',
  first_name: 'Morgan',
  last_name:  'Lee',
  role:       'general',
  created_at: '2024-11-05T14:22:47.000Z',
};

/**
 * Returns a signed JWT for the given user ID.
 *
 * @param {string} [userId]   Defaults to OWNER.user_id.
 * @param {object} [jwtOpts]  Extra options passed to jwt.sign (e.g. expiresIn).
 */
function makeToken(userId = OWNER.user_id, jwtOpts = {}) {
  return jwt.sign({ user_id: userId }, TEST_SECRET, { expiresIn: '1h', ...jwtOpts });
}

/** Returns an already-expired JWT — used to test the 403 expiry path. */
function makeExpiredToken(userId = OWNER.user_id) {
  return makeToken(userId, { expiresIn: '-1s' });
}

/** Returns a token signed with a different secret — used to test 403 wrong-secret path. */
function makeBadSecretToken(userId = OWNER.user_id) {
  return jwt.sign({ user_id: userId }, 'wrong-secret-that-is-not-test-secret');
}

module.exports = {
  TEST_SECRET,
  OWNER,
  OTHER,
  makeToken,
  makeExpiredToken,
  makeBadSecretToken,
};