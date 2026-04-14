'use strict';

/**
 * Audit record fixtures for integration tests.
 *
 * Three scenarios are covered:
 *   completed  — pipeline finished, audit_data populated (see sceneJson.js)
 *   queued     — pipeline running, audit_data null
 *   failed     — pipeline errored, audit_data null
 *
 * IDs use the UUID v4 format that PostgreSQL generates.
 * Timestamps use the ISO 8601 format returned by pg.
 * Scan IDs use the format produced by the mobile app (date + short hash).
 * Job IDs use the Modal Labs opaque ID format (prefixed base-32 ULID).
 */

const { OWNER, OTHER } = require('./users');

// ---------------------------------------------------------------------------
// Primary identifiers
// ---------------------------------------------------------------------------

const AUDIT_COMPLETED_ID = 'a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6';
const AUDIT_QUEUED_ID    = 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e';
const AUDIT_FAILED_ID    = 'c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f';

// Scan IDs are set by the mobile app before the upload; they group all frames
// belonging to one recording session.
const SCAN_ID_A = 'scan-20250115-a1b2c3d4';
const SCAN_ID_B = 'scan-20250201-b2c3d4e5';

// Modal Labs job IDs — opaque string returned by the pipeline /submit endpoint.
const JOB_ID_A = 'modal-01JBXK2P3Q4R5S6T7U8V9W0X1';
const JOB_ID_B = 'modal-01JCYK3Q4R5S6T7U8V9W0X1Y2';

// ---------------------------------------------------------------------------
// History rows
// Shape returned by GET /audits/history SQL window function:
//   { audit_id, status, room_name (Audit <n>), created_date (YYYY-MM-DD) }
// Results are ordered newest-first (DESC).
// ---------------------------------------------------------------------------

const historyRows = {
  /** Single completed audit — typical happy-path response. */
  singleCompleted: [
    {
      audit_id:     AUDIT_COMPLETED_ID,
      status:       'completed',
      room_name:    'Audit 1',
      created_date: '2025-01-15',
    },
  ],

  /**
   * Three audits for OWNER, ordered newest-first.
   * Covers all three status values and verifies that room_name numbering
   * is assigned chronologically (oldest = Audit 1).
   */
  threeAuditsForOwner: [
    {
      audit_id:     AUDIT_QUEUED_ID,
      status:       'queued',
      room_name:    'Audit 3',
      created_date: '2025-02-01',
    },
    {
      audit_id:     AUDIT_COMPLETED_ID,
      status:       'completed',
      room_name:    'Audit 2',
      created_date: '2025-01-20',
    },
    {
      audit_id:     AUDIT_FAILED_ID,
      status:       'failed',
      room_name:    'Audit 1',
      created_date: '2025-01-15',
    },
  ],
};

// ---------------------------------------------------------------------------
// Full DB rows
// Shape returned by INSERT/UPDATE ... RETURNING * on the audits table.
// audit_data is set to null here; tests that need populated audit_data
// should spread this and set audit_data to a sceneJson fixture.
// ---------------------------------------------------------------------------

const dbRows = {
  completed: {
    audit_id:   AUDIT_COMPLETED_ID,
    created_by: OWNER.user_id,
    scan_id:    SCAN_ID_A,
    job_id:     JOB_ID_A,
    status:     'completed',
    audit_data: null,
    created_at: '2025-01-15T14:32:07.000Z',
  },

  queued: {
    audit_id:   AUDIT_QUEUED_ID,
    created_by: OWNER.user_id,
    scan_id:    SCAN_ID_B,
    job_id:     JOB_ID_B,
    status:     'queued',
    audit_data: null,
    created_at: '2025-02-01T10:05:44.000Z',
  },

  failed: {
    audit_id:   AUDIT_FAILED_ID,
    created_by: OWNER.user_id,
    scan_id:    SCAN_ID_A,
    job_id:     JOB_ID_A,
    status:     'failed',
    audit_data: null,
    created_at: '2025-01-15T14:32:07.000Z',
  },
};

// ---------------------------------------------------------------------------
// Pipeline callback request bodies
// Shape of POST /pipeline/callback body sent by the Modal worker.
// ---------------------------------------------------------------------------

const callbackBodies = {
  /** Normal successful completion. */
  completed: {
    scan_id: SCAN_ID_A,
    job_id:  JOB_ID_A,
    status:  'completed',
  },

  /** The pipeline also emits "success" as a valid success status. */
  successAlias: {
    scan_id: SCAN_ID_A,
    job_id:  JOB_ID_A,
    status:  'success',
  },

  /** Pipeline encountered an error during reconstruction. */
  failed: {
    scan_id: SCAN_ID_A,
    job_id:  JOB_ID_A,
    status:  'failed',
  },

  /** job_id is optional — some early pipeline versions omit it. */
  completedNoJobId: {
    scan_id: SCAN_ID_A,
    status:  'completed',
  },

  /** Missing scan_id — should produce 400. */
  missingScanId: {
    job_id: JOB_ID_A,
    status: 'completed',
  },

  /** Missing status — should produce 400. */
  missingStatus: {
    scan_id: SCAN_ID_A,
    job_id:  JOB_ID_A,
  },
};

module.exports = {
  AUDIT_COMPLETED_ID,
  AUDIT_QUEUED_ID,
  AUDIT_FAILED_ID,
  SCAN_ID_A,
  SCAN_ID_B,
  JOB_ID_A,
  JOB_ID_B,
  historyRows,
  dbRows,
  callbackBodies,
};