'use strict';

/**
 * Integration tests for audit-related routes.
 *
 * Routes under test:
 *   POST /register
 *   POST /login
 *   GET  /audits/history
 *   GET  /audits/:id/result
 *   POST /pipeline/callback
 *   POST /scan/batch
 *
 * Mocking strategy
 * ----------------
 * db.js and supabaseClient.js are replaced with explicit factory mocks so that:
 *  - No real pg Pool, Supabase client, or network connections are created.
 *  - All inner jest.fn() references are stable and captured once at module level,
 *    so individual tests can configure return values without recreating mocks.
 *  - jest.clearAllMocks() in beforeEach wipes call history and once-queues without
 *    losing the mock structure or default implementations.
 *
 * Authentication
 * --------------
 * JWTs are signed with TEST_SECRET using the real jsonwebtoken library so the
 * authorize middleware exercises its actual jwt.verify() logic, not a stub.
 *
 * Run with:
 *   npm test   (from src/prototypes/server)
 */

// ==================================================================
// 1. Mock factories — must be declared before any require() calls.
//    Jest hoists jest.mock() to the top of the compiled output, so
//    these factories execute before server.js is loaded.
// ==================================================================

/**
 * db.js mock
 * The real module exports { query: (text, params) => pool.query(...) }.
 * We replace it with a single jest.fn() that tests control per-test.
 */
jest.mock('../db', () => ({
  query: jest.fn(),
}));

/**
 * supabaseClient.js mock
 * The real module exports the Supabase client instance directly.
 * server.js uses it as:
 *   supabase.storage.from('bucket').download(path)
 *   supabase.storage.from('bucket').upload(path, buf, opts)
 *
 * We build the exact same chain using stable jest.fn() references
 * and expose them via _mock* properties so tests can reach them with
 * jest.requireMock('../supabaseClient')._mockDownload, etc.
 */
jest.mock('../supabaseClient', () => {
  const mockDownload = jest.fn();
  const mockUpload   = jest.fn();
  const mockFrom     = jest.fn(() => ({ download: mockDownload, upload: mockUpload }));

  return {
    storage: { from: mockFrom },
    _mockFrom:     mockFrom,
    _mockDownload: mockDownload,
    _mockUpload:   mockUpload,
  };
});

/**
 * bcrypt mock
 * Replaced with jest.fn()s so tests do not pay the cost of real bcrypt
 * rounds and can control hash/compare outcomes per test.
 */
jest.mock('bcrypt', () => ({
  hash:    jest.fn(),
  compare: jest.fn(),
}));

// ==================================================================
// 2. Stable references to mock internals
// ==================================================================
const { query: mockDbQuery }                                    = jest.requireMock('../db');
const { _mockFrom, _mockDownload, _mockUpload: mockUpload }     = jest.requireMock('../supabaseClient');
const { hash: mockBcryptHash, compare: mockBcryptCompare }      = jest.requireMock('bcrypt');

// ==================================================================
// 3. Fixtures
// ==================================================================
const users     = require('./fixtures/users');
const auditFx   = require('./fixtures/audits');
const sceneJson = require('./fixtures/sceneJson');

// ==================================================================
// 4. Set env vars and load the app.
//    JWT_SECRET must be on process.env before server.js is required.
//    ML_PIPELINE_URL must be set so fetch() in POST /scan/batch has a
//    defined URL; the real fetch is replaced by a jest.fn() below.
// ==================================================================
process.env.JWT_SECRET       = users.TEST_SECRET;
process.env.ML_PIPELINE_URL  = 'https://fake-pipeline.example.com/submit';

// Replace global fetch so POST /scan/batch never touches the network.
global.fetch = jest.fn();

const request = require('supertest');
const app     = require('../server');

// ==================================================================
// 5. Reset mock state between tests
// ==================================================================
beforeEach(() => {
  jest.clearAllMocks();
});

// ==================================================================
// Helpers
// ==================================================================

/** Queues one DB result row-set for the next db.query() call. */
function setupDbRows(rows) {
  mockDbQuery.mockResolvedValueOnce({ rows });
}

/** Queues one Supabase download result for the next .download() call. */
function setupDownload(result) {
  _mockDownload.mockResolvedValueOnce(result);
}

// ==================================================================
// GET /audits/history
// ==================================================================
describe('GET /audits/history', () => {

  test('200 — returns audit list for authenticated user', async () => {
    setupDbRows(auditFx.historyRows.threeAuditsForOwner);

    const res = await request(app)
      .get('/audits/history')
      .set('token', users.makeToken(users.OWNER.user_id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(auditFx.historyRows.threeAuditsForOwner);
  });

  test('200 — response includes room_name and created_date fields from window function', async () => {
    setupDbRows(auditFx.historyRows.threeAuditsForOwner);

    const res = await request(app)
      .get('/audits/history')
      .set('token', users.makeToken());

    const first = res.body[0];
    // Newest audit returned first (ORDER BY created_at DESC)
    expect(first.audit_id).toBe(auditFx.AUDIT_QUEUED_ID);
    expect(first.room_name).toBe('Audit 3');
    expect(first.created_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['queued', 'completed', 'failed']).toContain(first.status);
  });

  test('200 — passes user_id from JWT (not request body) to the WHERE clause', async () => {
    setupDbRows([]);

    await request(app)
      .get('/audits/history')
      .set('token', users.makeToken(users.OWNER.user_id));

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+created_by\s*=\s*\$1/i);
    expect(params).toEqual([users.OWNER.user_id]);
  });

  test('200 — returns empty array when user has no audits', async () => {
    setupDbRows([]);

    const res = await request(app)
      .get('/audits/history')
      .set('token', users.makeToken());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('200 — single completed audit', async () => {
    setupDbRows(auditFx.historyRows.singleCompleted);

    const res = await request(app)
      .get('/audits/history')
      .set('token', users.makeToken());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('completed');
    expect(res.body[0].room_name).toBe('Audit 1');
  });

  test('403 — no token header rejects before hitting the DB', async () => {
    const res = await request(app).get('/audits/history');

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('403 — malformed token string is rejected', async () => {
    const res = await request(app)
      .get('/audits/history')
      .set('token', 'not.a.valid.jwt');

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('403 — token signed with a different secret is rejected', async () => {
    const res = await request(app)
      .get('/audits/history')
      .set('token', users.makeBadSecretToken());

    expect(res.status).toBe(403);
  });

  test('403 — expired token is rejected', async () => {
    const res = await request(app)
      .get('/audits/history')
      .set('token', users.makeExpiredToken());

    expect(res.status).toBe(403);
  });

  test('500 — database error surfaces as 500', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('Connection pool exhausted'));

    const res = await request(app)
      .get('/audits/history')
      .set('token', users.makeToken());

    expect(res.status).toBe(500);
  });
});

// ==================================================================
// GET /audits/:id/result
// ==================================================================
describe('GET /audits/:id/result', () => {

  test('200 — returns fullyCompliant audit_data for the owning user', async () => {
    setupDbRows([{ audit_data: sceneJson.fullyCompliant }]);

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken(users.OWNER.user_id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(sceneJson.fullyCompliant);
  });

  test('200 — compliance_report contains all 7 standard checks', async () => {
    setupDbRows([{ audit_data: sceneJson.fullyCompliant }]);

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken());

    const report = res.body.compliance_report;
    expect(report).toHaveLength(7);

    const testIds = report.map(item => item.test_id);
    expect(testIds).toContain('turning_radius');
    expect(testIds).toContain('toilet_seat_height');
    expect(testIds).toContain('door_width');
    expect(testIds).toContain('grab_bar_obstruction');
    expect(testIds).toContain('ToilerPaper_height');
    expect(testIds).toContain('dispenser_height');
    expect(testIds).toContain('emergency_button_height');
  });

  test('200 — withFailures: red and yellow items include regulations and recommendations', async () => {
    setupDbRows([{ audit_data: sceneJson.withFailures }]);

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken());

    const report = res.body.compliance_report;

    // All red/yellow items must carry remediation guidance
    const nonGreen = report.filter(i => i.status === 'red' || i.status === 'yellow');
    expect(nonGreen.length).toBeGreaterThan(0);
    for (const item of nonGreen) {
      expect(item.regulations).toBeTruthy();
      expect(item.recommendations).toBeTruthy();
    }

    // Green items must NOT carry remediation guidance
    const green = report.filter(i => i.status === 'green');
    for (const item of green) {
      expect(item.regulations).toBeFalsy();
      expect(item.recommendations).toBeFalsy();
    }
  });

  test('200 — withFailures: turning_radius is red with measured_value 1.31', async () => {
    setupDbRows([{ audit_data: sceneJson.withFailures }]);

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken());

    const turning = res.body.compliance_report.find(i => i.test_id === 'turning_radius');
    expect(turning.status).toBe('red');
    expect(turning.measured_value).toBe(1.31);
  });

  test('200 — withFailures: door_width is yellow (minimum-standard compliant)', async () => {
    setupDbRows([{ audit_data: sceneJson.withFailures }]);

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken());

    const door = res.body.compliance_report.find(i => i.test_id === 'door_width');
    expect(door.status).toBe('yellow');
    expect(door.measured_value).toBeGreaterThanOrEqual(0.864);
    expect(door.measured_value).toBeLessThanOrEqual(0.914);
  });

  test('200 — noObjectsDetected: audit_data is still returned (all statuses are unknown)', async () => {
    setupDbRows([{ audit_data: sceneJson.noObjectsDetected }]);

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken());

    expect(res.status).toBe(200);
    const report = res.body.compliance_report;
    const unknowns = report.filter(i => i.status === 'unknown');
    // Only turning_radius can be non-unknown (footprint geometry still gives a diameter)
    expect(unknowns.length).toBeGreaterThanOrEqual(6);
  });

  test('200 — null audit_data (queued audit) is returned as null', async () => {
    setupDbRows([{ audit_data: null }]);

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_QUEUED_ID}/result`)
      .set('token', users.makeToken());

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  test('ownership enforced — SQL binds audit_id=$1 AND created_by=$2', async () => {
    setupDbRows([{ audit_data: sceneJson.fullyCompliant }]);

    await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken(users.OWNER.user_id));

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/audit_id\s*=\s*\$1/i);
    expect(sql).toMatch(/created_by\s*=\s*\$2/i);
    expect(params).toEqual([auditFx.AUDIT_COMPLETED_ID, users.OWNER.user_id]);
  });

  test('404 — audit belongs to a different user (OTHER cannot read OWNER\'s audit)', async () => {
    setupDbRows([]); // 0 rows because created_by ≠ OTHER.user_id

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken(users.OTHER.user_id));

    expect(res.status).toBe(404);
  });

  test('404 — non-existent audit_id returns 404', async () => {
    setupDbRows([]);

    const res = await request(app)
      .get('/audits/00000000-0000-0000-0000-000000000000/result')
      .set('token', users.makeToken());

    expect(res.status).toBe(404);
  });

  test('403 — no token header is rejected before DB query', async () => {
    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`);

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('403 — expired token is rejected', async () => {
    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeExpiredToken());

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('403 — token with wrong secret is rejected', async () => {
    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeBadSecretToken());

    expect(res.status).toBe(403);
  });

  test('500 — database error surfaces as 500', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('Query timeout'));

    const res = await request(app)
      .get(`/audits/${auditFx.AUDIT_COMPLETED_ID}/result`)
      .set('token', users.makeToken());

    expect(res.status).toBe(500);
  });
});

// ==================================================================
// POST /pipeline/callback
// ==================================================================
describe('POST /pipeline/callback', () => {

  const completedDbRow = {
    ...auditFx.dbRows.completed,
    audit_data: sceneJson.fullyCompliant,
  };

  // ==================================================================
  // Input validation
  // ==================================================================
  describe('input validation', () => {
    test('400 — missing scan_id', async () => {
      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.missingScanId);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/scan_id/i);
      expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('400 — missing status', async () => {
      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.missingStatus);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/status/i);
      expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('400 — empty body', async () => {
      const res = await request(app)
        .post('/pipeline/callback')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ==================================================================
  // Completed path
  // ==================================================================
  describe('"completed" status', () => {
    test('200 — downloads scene.json from audit-outputs bucket at correct path', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.fullyCompliant));
      setupDbRows([completedDbRow]);

      await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      expect(_mockFrom).toHaveBeenCalledWith('audit-outputs');
      expect(_mockDownload).toHaveBeenCalledWith(
        `${auditFx.SCAN_ID_A}/scene.json`
      );
    });

    test('200 — updates audit row and returns success', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.fullyCompliant));
      setupDbRows([completedDbRow]);

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.audit.audit_id).toBe(auditFx.AUDIT_COMPLETED_ID);
      expect(res.body.audit.status).toBe('completed');
    });

    test('200 — parsed scene.json (fullyCompliant) is stored as audit_data ($2)', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.fullyCompliant));
      setupDbRows([completedDbRow]);

      await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      const [sql, params] = mockDbQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE audits/i);
      expect(params[0]).toBe('completed');                       // $1 status
      expect(params[1]).toEqual(sceneJson.fullyCompliant);       // $2 audit_data (parsed object)
      expect(params[2]).toBe(auditFx.SCAN_ID_A);                 // $3 scan_id
      expect(params[3]).toBe(auditFx.JOB_ID_A);                  // $4 job_id
    });

    test('200 — withFailures scene.json is stored as audit_data correctly', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.withFailures));
      setupDbRows([{ ...auditFx.dbRows.completed, audit_data: sceneJson.withFailures }]);

      await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      const [, params] = mockDbQuery.mock.calls[0];
      // Verify a recognisable field from the failures fixture is present
      expect(params[1].compliance_report[0].status).toBe('red');
      expect(params[1].compliance_report[0].measured_value).toBe(1.31);
    });

    test('200 — "success" status alias downloads scene.json identically to "completed"', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.fullyCompliant));
      setupDbRows([{ ...completedDbRow, status: 'success' }]);

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.successAlias);

      expect(res.status).toBe(200);
      expect(_mockDownload).toHaveBeenCalledTimes(1);
    });

    test('200 — job_id is optional; absent value does not prevent a 200 response', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.fullyCompliant));
      setupDbRows([completedDbRow]);

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completedNoJobId);

      expect(res.status).toBe(200);
    });
  });

  // ==================================================================
  // Failed path
  // ==================================================================
  describe('"failed" status', () => {
    const failedDbRow = auditFx.dbRows.failed;

    test('200 — does not contact Supabase Storage', async () => {
      setupDbRows([failedDbRow]);

      await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.failed);

      expect(_mockFrom).not.toHaveBeenCalled();
      expect(_mockDownload).not.toHaveBeenCalled();
    });

    test('200 — sets status to "failed" in the DB UPDATE', async () => {
      setupDbRows([failedDbRow]);

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.failed);

      expect(res.status).toBe(200);
      const [, params] = mockDbQuery.mock.calls[0];
      expect(params[0]).toBe('failed');
    });

    /**
     * BUG — finalAuditData undeclared variable
     *
     * In server.js `finalAuditData` is only assigned inside the
     * `if (status === 'success' || status === 'completed')` block but
     * referenced as $2 in the UPDATE query for ALL statuses.
     *
     * Because `finalAuditData` is never declared with `let`/`const` it
     * becomes an implicit global that persists across requests in the same
     * server process.  After any "completed" callback runs, a subsequent
     * "failed" callback silently writes the PREVIOUS audit's scene.json
     * as $2, corrupting the failed row with someone else's data.
     *
     * In the test suite the "completed" describe block runs first, so by
     * the time this test runs, finalAuditData holds stale scene.json from
     * those earlier tests — it is NOT null as it should be.
     *
     * Fix: declare `let finalAuditData = null;` before the if-block in
     * server.js.  After fixing, change the expectation to:
     *   expect(capturedParams[1]).toBeNull();
     */
    test('BUG — "failed" path writes stale audit_data ($2) to the DB instead of null', async () => {
      let capturedParams;
      mockDbQuery.mockImplementationOnce((_sql, params) => {
        capturedParams = params;
        return Promise.resolve({ rows: [failedDbRow] });
      });

      await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.failed);

      // $2 should be null (no audit data for a failed job), but the implicit
      // global retains stale data from the most recent completed callback.
      expect(capturedParams[1]).toBeNull();
      // Fix target: expect(capturedParams[1]).toBeNull();
    });
  });

  // ==================================================================
  // Supabase error handling
  // ==================================================================
  describe('Supabase error handling', () => {
    test('200 — Supabase download error is logged but DB update still runs', async () => {
      // Supabase returns { data: null, error: {...} } on storage errors
      setupDownload({ data: null, error: { message: 'Object not found', status: 404 } });
      setupDbRows([completedDbRow]);

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      expect(res.status).toBe(200);
      expect(mockDbQuery).toHaveBeenCalledTimes(1);
    });

    test('500 — malformed scene.json (JSON.parse throws) skips DB update and returns 500', async () => {
      setupDownload({ data: { text: () => Promise.resolve('not { valid } json }{{{') }, error: null });
      // REMOVED setupDbRows to prevent the mock cascade!

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      expect(res.status).toBe(500); // Changed to expect your server's 500 response
      expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('500 — supabase.storage.from() throwing skips DB update and returns 500', async () => {
      _mockFrom.mockImplementationOnce(() => {
        throw new Error('Supabase client not initialised');
      });
      // REMOVED setupDbRows to prevent the mock cascade!

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      expect(res.status).toBe(500); // Changed to expect your server's 500 response
      expect(mockDbQuery).not.toHaveBeenCalled();
    });
  });

  // ==================================================================
  // Not found
  // ==================================================================
  describe('not found', () => {
    test('404 — scan_id does not match any audit row', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.fullyCompliant));
      setupDbRows([]); // UPDATE … RETURNING * → 0 rows

      const res = await request(app)
        .post('/pipeline/callback')
        .send({
          scan_id: 'scan-00000000-does-not-exist',
          job_id:  auditFx.JOB_ID_A,
          status:  'completed',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  // ==================================================================
  // Database failure
  // ==================================================================
  describe('database failure', () => {
    test('500 — DB UPDATE throwing returns 500', async () => {
      setupDownload(sceneJson.asDownloadResult(sceneJson.fullyCompliant));
      mockDbQuery.mockRejectedValueOnce(new Error('Deadlock detected'));

      const res = await request(app)
        .post('/pipeline/callback')
        .send(auditFx.callbackBodies.completed);

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/server error/i);
    });
  });
});

// ==================================================================
// POST /register  (TC-01, TC-02)
// ==================================================================
describe('POST /register', () => {

  const newUser = {
    user_id:       'aa1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d',
    email:         'new.auditor@accessibility-firm.com',
    first_name:    'Jamie',
    last_name:     'Rivera',
    role:          'general',
    created_at:    '2025-03-01T10:00:00.000Z',
    password_hash: '$2b$10$fakehashvalue',
  };

  test('TC-01 — 200: creates user and returns token + user_role for a new email', async () => {
    mockBcryptHash.mockResolvedValueOnce('$2b$10$fakehashvalue');
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })         // SELECT: email not taken
      .mockResolvedValueOnce({ rows: [newUser] }); // INSERT RETURNING *

    const res = await request(app)
      .post('/register')
      .send({ email: newUser.email, password: 'password123', first_name: 'Jamie', last_name: 'Rivera' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user_role).toBe('general');
  });

  test('TC-01 — password is hashed before insert; plaintext never reaches the DB', async () => {
    mockBcryptHash.mockResolvedValueOnce('$2b$10$fakehashvalue');
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [newUser] });

    await request(app)
      .post('/register')
      .send({ email: newUser.email, password: 'password123' });

    expect(mockBcryptHash).toHaveBeenCalledWith('password123', 10);
    const [, insertParams] = mockDbQuery.mock.calls[1];
    expect(insertParams[1]).toBe('$2b$10$fakehashvalue'); // $2 = password_hash column
    expect(insertParams[1]).not.toBe('password123');
  });

  test('TC-01 — role defaults to "general" when omitted from request body', async () => {
    mockBcryptHash.mockResolvedValueOnce('$2b$10$fakehashvalue');
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [newUser] });

    const res = await request(app)
      .post('/register')
      .send({ email: newUser.email, password: 'pass' });

    expect(res.status).toBe(200);
    const [, insertParams] = mockDbQuery.mock.calls[1];
    expect(insertParams[4]).toBe('general'); // $5 = role column
  });

  test('TC-02 — 401: duplicate email returns 401 and skips hashing + insert', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [newUser] }); // email already exists

    const res = await request(app)
      .post('/register')
      .send({ email: newUser.email, password: 'password123' });

    expect(res.status).toBe(401);
    expect(mockBcryptHash).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(1); // only the SELECT, no INSERT
  });

  test('500 — database error returns 500', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('Connection pool exhausted'));

    const res = await request(app)
      .post('/register')
      .send({ email: 'any@test.com', password: 'pass' });

    expect(res.status).toBe(500);
  });
});

// ==================================================================
// POST /login  (TC-03, TC-04)
// ==================================================================
describe('POST /login', () => {

  const existingUser = {
    user_id:       users.OWNER.user_id,
    email:         users.OWNER.email,
    password_hash: '$2b$10$storedHashForOwner',
    role:          'general',
  };

  test('TC-03 — 200: valid credentials return a JWT and user_role', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [existingUser] });
    mockBcryptCompare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/login')
      .send({ email: existingUser.email, password: 'correctpassword' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user_role).toBe('general');
  });

  test('TC-03 — bcrypt.compare is called with the submitted plaintext and the stored hash', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [existingUser] });
    mockBcryptCompare.mockResolvedValueOnce(true);

    await request(app)
      .post('/login')
      .send({ email: existingUser.email, password: 'correctpassword' });

    expect(mockBcryptCompare).toHaveBeenCalledWith('correctpassword', existingUser.password_hash);
  });

  test('TC-04 — 401: wrong password returns 401', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [existingUser] });
    mockBcryptCompare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/login')
      .send({ email: existingUser.email, password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body).toMatch(/incorrect/i);
  });

  test('TC-04 — 401: unknown email returns 401 without calling bcrypt', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/login')
      .send({ email: 'nobody@test.com', password: 'anything' });

    expect(res.status).toBe(401);
    expect(mockBcryptCompare).not.toHaveBeenCalled();
  });

  test('TC-04 — same error body for wrong password and unknown email (no email enumeration)', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const resUnknown = await request(app)
      .post('/login')
      .send({ email: 'nobody@test.com', password: 'anything' });

    mockDbQuery.mockResolvedValueOnce({ rows: [existingUser] });
    mockBcryptCompare.mockResolvedValueOnce(false);
    const resWrongPw = await request(app)
      .post('/login')
      .send({ email: existingUser.email, password: 'wrongpassword' });

    expect(resUnknown.body).toEqual(resWrongPw.body);
  });

  test('500 — database error returns 500', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('Query timeout'));

    const res = await request(app)
      .post('/login')
      .send({ email: existingUser.email, password: 'pass' });

    expect(res.status).toBe(500);
  });
});

// ==================================================================
// POST /scan/batch  (TC-08, TC-13)
// ==================================================================
describe('POST /scan/batch', () => {

  const SCAN_ID      = 'scan-20250301-test1234';
  const metadataJson = JSON.stringify({ scanId: SCAN_ID });

  // Minimal valid JPEG magic bytes — small enough to stay well under the 2 MB limit.
  const fakeFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  /** Helper: mock a successful Supabase upload response. */
  function setupUploadSuccess() {
    mockUpload.mockResolvedValue({ error: null });
  }

  /** Helper: mock a successful pipeline HTTP response. */
  function setupPipelineSuccess(jobId = auditFx.JOB_ID_A) {
    global.fetch.mockResolvedValueOnce({
      ok:   true,
      text: () => Promise.resolve(JSON.stringify({ job_id: jobId, status: 'queued' })),
    });
  }

  // ----------------------------------------------------------------
  // TC-13 — validation
  // ----------------------------------------------------------------
  test('TC-13 — 400: no files returns 400 before touching Supabase or DB', async () => {
    const res = await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken())
      .field('metadata', metadataJson);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no frames/i);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('TC-13 — 400: missing scanId in metadata returns 400', async () => {
    const res = await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken())
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .field('metadata', JSON.stringify({}));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scanId/i);
  });

  test('TC-13 — 400: invalid metadata JSON returns 400', async () => {
    const res = await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken())
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .field('metadata', 'not-valid-json{{{');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metadata/i);
  });

  test('TC-13 — 403: missing token is rejected before any processing', async () => {
    const res = await request(app)
      .post('/scan/batch')
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .field('metadata', metadataJson);

    expect(res.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // TC-08 — happy path
  // ----------------------------------------------------------------
  test('TC-08 — 200: frames uploaded, pipeline triggered, audit row inserted with status "queued"', async () => {
    setupUploadSuccess();
    setupPipelineSuccess();
    mockDbQuery.mockResolvedValueOnce({ rows: [auditFx.dbRows.queued] });

    const res = await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken())
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .field('metadata', metadataJson);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.audit).not.toBeNull();
    expect(res.body.audit.status).toBe('queued');
  });

  test('TC-08 — each frame is uploaded to audit-inputs/{scanId}/frame_N.jpg', async () => {
    setupUploadSuccess();
    setupPipelineSuccess();
    mockDbQuery.mockResolvedValueOnce({ rows: [auditFx.dbRows.queued] });

    await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken())
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .attach('frames', fakeFrame, { filename: 'frame_00001.jpg', contentType: 'image/jpeg' })
      .field('metadata', metadataJson);

    expect(_mockFrom).toHaveBeenCalledWith('audit-inputs');
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockUpload.mock.calls[0][0]).toBe(`${SCAN_ID}/frame_00000.jpg`);
    expect(mockUpload.mock.calls[1][0]).toBe(`${SCAN_ID}/frame_00001.jpg`);
  });

  test('TC-08 — DB INSERT binds the user_id from the JWT (not from request body)', async () => {
    setupUploadSuccess();
    setupPipelineSuccess();
    mockDbQuery.mockResolvedValueOnce({ rows: [auditFx.dbRows.queued] });

    await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken(users.OWNER.user_id))
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .field('metadata', metadataJson);

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO audits/i);
    expect(params[0]).toBe(users.OWNER.user_id); // $1 = created_by
    expect(params[1]).toBe(SCAN_ID);             // $2 = scan_id
  });

  test('TC-08 — pipeline failure is logged and swallowed; response is 200 with audit: null', async () => {
    setupUploadSuccess();
    global.fetch.mockResolvedValueOnce({
      ok:     false,
      status: 500,
      text:   () => Promise.resolve('Internal pipeline error'),
    });

    const res = await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken())
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .field('metadata', metadataJson);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.audit).toBeNull();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('500 — Supabase upload failure returns 500', async () => {
    mockUpload.mockResolvedValue({ error: { message: 'Storage quota exceeded' } });

    const res = await request(app)
      .post('/scan/batch')
      .set('token', users.makeToken())
      .attach('frames', fakeFrame, { filename: 'frame_00000.jpg', contentType: 'image/jpeg' })
      .field('metadata', metadataJson);

    expect(res.status).toBe(500);
  });
});