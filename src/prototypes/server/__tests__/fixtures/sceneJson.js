'use strict';

/**
 * Realistic scene.json fixtures for integration tests.
 *
 * Scene.json is the final output of the full pipeline, stored as the
 * `audit_data` JSONB column in the audits table and returned verbatim by
 * GET /audits/:id/result. The frontend (audit-detail/[id].tsx) reads
 * `compliance_report` from this object to render the compliance checklist.
 *
 * Three fixtures model distinct real-world outcomes:
 *
 *   fullyCompliant   — All detectable checks pass (green).
 *                      Dispenser + emergency button are absent (unknown).
 *                      Represents a recently-renovated accessible bathroom.
 *
 *   withFailures     — Narrow room, low toilet, obstructed grab bar, and
 *                      out-of-range fixtures. Exercises red/yellow statuses
 *                      and the regulations/recommendations fields that
 *                      compliance_check.py appends only for non-green items.
 *
 *   noObjectsDetected — Sparse COLMAP reconstruction: floor and walls were
 *                       detected but YOLO found no bathroom objects. All
 *                       compliance items return "unknown".
 *                       Represents a failed scan with usable geometry.
 *
 * Data derivation
 * ---------------
 * compliance_report entries match the rules in standards.json exactly:
 *   turning_radius    >= 1.50m → green
 *   toilet_seat_height  0.430–0.485m → green
 *   door_width        >= 0.915m → green, 0.864–0.914m → yellow
 *   grab_bar_obstruction false → green
 *   ToilerPaper_height  0.380–1.219m → green
 *   dispenser_height    1.120–1.220m → green
 *   emergency_button_height 0.700–1.200m → green
 *
 * Object shapes match step3_detect_items.py output:
 *   { id, type, confidence, position [x,y,z], bbox_aligned {min,max}, support_plane, evidence }
 *
 * World state shapes match extractor.py output:
 *   { toilet, grab_bar, dispenser, emergency_button, door, room_clearance }
 */

// ---------------------------------------------------------------------------
// Shared geometry helpers
// ---------------------------------------------------------------------------

/**
 * A standard accessible-bathroom floor plan: 2.41m wide × 2.00m deep.
 * Yields a min(width, depth) = 2.00m, but after obstacle subtraction the
 * usable turning circle is 1.82m diameter (all obstacles near walls).
 */
const STANDARD_FLOOR_PLAN = {
  planes: [
    {
      id:           'floor',
      type:         'floor',
      normal:       [0, 1, 0],
      point:        [0, 0, 0],
      inlier_count: 3142,
    },
    {
      id:           'wall_west',
      type:         'wall',
      normal:       [1, 0, 0],
      point:        [-1.205, 0.9, 0],
      inlier_count: 1208,
    },
    {
      id:           'wall_east',
      type:         'wall',
      normal:       [-1, 0, 0],
      point:        [1.205, 0.9, 0],
      inlier_count: 1094,
    },
    {
      id:           'wall_south',
      type:         'wall',
      normal:       [0, 0, 1],
      point:        [0, 0.9, -1.0],
      inlier_count: 987,
    },
    {
      id:           'wall_north',
      type:         'wall',
      normal:       [0, 0, -1],
      point:        [0, 0.9, 1.0],
      inlier_count: 1011,
    },
  ],
  footprint: {
    polygon_xz: [
      [-1.205, -1.0],
      [ 1.205, -1.0],
      [ 1.205,  1.0],
      [-1.205,  1.0],
    ],
  },
};

/**
 * A cramped non-compliant bathroom: 1.60m wide × 1.45m deep.
 * min(1.60, 1.45) = 1.45m; with objects in the path the usable circle
 * shrinks to 1.31m diameter.
 */
const NARROW_FLOOR_PLAN = {
  planes: [
    {
      id:           'floor',
      type:         'floor',
      normal:       [0, 1, 0],
      point:        [0, 0, 0],
      inlier_count: 1876,
    },
    {
      id:           'wall_west',
      type:         'wall',
      normal:       [1, 0, 0],
      point:        [-0.80, 0.9, 0],
      inlier_count: 802,
    },
    {
      id:           'wall_east',
      type:         'wall',
      normal:       [-1, 0, 0],
      point:        [0.80, 0.9, 0],
      inlier_count: 754,
    },
    {
      id:           'wall_south',
      type:         'wall',
      normal:       [0, 0, 1],
      point:        [0, 0.9, -0.725],
      inlier_count: 634,
    },
    {
      id:           'wall_north',
      type:         'wall',
      normal:       [0, 0, -1],
      point:        [0, 0.9, 0.725],
      inlier_count: 701,
    },
  ],
  footprint: {
    polygon_xz: [
      [-0.80, -0.725],
      [ 0.80, -0.725],
      [ 0.80,  0.725],
      [-0.80,  0.725],
    ],
  },
};

// ---------------------------------------------------------------------------
// Fixture 1 — fullyCompliant
// All detected objects pass. Dispenser and emergency button absent (unknown).
// ---------------------------------------------------------------------------

const fullyCompliant = {
  ...STANDARD_FLOOR_PLAN,

  objects: [
    {
      id:           'toilet_1',
      type:         'toilet',
      confidence:   0.893,
      // Seat top (bbox max Y) = 0.732m; after tank heuristic (> 0.60m → subtract 0.20m):
      // effective toilet_height = 0.732 - 0.20 = 0.532... wait let me recalculate
      // Actually extractor uses get_max_height which is bbox_aligned.max[1].
      // For a seat-height of ~0.456 we need bbox max Y ≈ 0.456 + 0.20 (tank) = 0.656m
      // 0.656 > 0.60 → subtract 0.20 → 0.456. Within 0.430-0.485 → green. ✓
      position:     [-0.65, 0.0, 0.60],
      bbox_aligned: {
        min: [-0.92, -0.02, 0.32],
        max: [-0.38,  0.656, 0.88],
      },
      support_plane: 'floor',
      evidence: {
        num_points:    187,
        num_detections: 14,
        image_names:   ['frame_0012.jpg', 'frame_0019.jpg', 'frame_0027.jpg', 'frame_0041.jpg'],
      },
    },
    {
      // grab_handle type is what extractor.py searches for (get_first_object(objects, ["grab_handle"]))
      id:           'grab_handle_1',
      type:         'grab_handle',
      confidence:   0.814,
      // Centroid Y = 0.872m — grab bar height. is_obstructed hardcoded False in extractor.
      position:     [-1.19, 0.872, 0.45],
      bbox_aligned: {
        min: [-1.205, 0.815, 0.12],
        max: [-1.175, 0.929, 0.78],
      },
      support_plane: 'wall_west',
      evidence: {
        num_points:    52,
        num_detections: 9,
        image_names:   ['frame_0007.jpg', 'frame_0015.jpg', 'frame_0023.jpg'],
      },
    },
    {
      // Door handle — used by extractor for door position but width is always null
      id:           'door_handle_1',
      type:         'door_handle',
      confidence:   0.761,
      position:     [1.10, 1.05, -0.72],
      bbox_aligned: {
        min: [1.07, 0.92, -0.78],
        max: [1.13, 1.18, -0.66],
      },
      support_plane: 'wall_east',
      evidence: {
        num_points:    23,
        num_detections: 5,
        image_names:   ['frame_0003.jpg', 'frame_0031.jpg'],
      },
    },
  ],

  objects_meta: {
    source:               'step3_detect_items',
    floor_alignment_json: 'floor_alignment.json',
  },

  compliance_report: [
    {
      test_id:       'turning_radius',
      name:          'Turning Diameter',
      target_object: 'room_clearance',
      measured_value: 1.82,
      status:        'green',
      message:       'Compliant (Best Practice)',
    },
    {
      test_id:       'toilet_seat_height',
      name:          'Toilet Seat Height',
      target_object: 'toilet',
      measured_value: 0.456,
      status:        'green',
      message:       'Compliant (Best Practice)',
    },
    {
      // door object found (door_handle detected) but width_m is always null from extractor
      test_id:       'door_width',
      name:          'Door Clear Width',
      target_object: 'door',
      measured_value: null,
      status:        'unknown',
      message:       'Data not detected or skipped',
    },
    {
      test_id:       'grab_bar_obstruction',
      name:          'Grab Bar Obstruction Check',
      target_object: 'grab_bar',
      measured_value: false,
      status:        'green',
      message:       'Compliant (Best Practice)',
    },
    {
      test_id:       'ToilerPaper_height',
      name:          'Toiler Paper Dispenser Controls Height',
      target_object: 'dispenser',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'dispenser' not found",
    },
    {
      test_id:       'dispenser_height',
      name:          'Dispenser Controls Height',
      target_object: 'dispenser',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'dispenser' not found",
    },
    {
      test_id:       'emergency_button_height',
      name:          'Emergency Button Position',
      target_object: 'emergency_button',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'emergency_button' not found",
    },
  ],

  world_state_debug: {
    toilet: {
      position:  [-0.65, 0.0, 0.60],
      height_m:  0.456,
    },
    grab_bar: {
      position:              [-1.19, 0.872, 0.45],
      height_m:              0.872,
      distance_to_toilet_m:  0.634,
      is_obstructed:         false,
    },
    dispenser: {
      position: null,
      height_m: null,
    },
    emergency_button: {
      position: null,
      height_m: null,
    },
    door: {
      position: [1.10, 1.05, -0.72],
      width_m:  null,
    },
    room_clearance: {
      diameter_m: 1.82,
    },
  },
};

// ---------------------------------------------------------------------------
// Fixture 2 — withFailures
// Cramped bathroom with multiple non-compliant measurements.
// Exercises red/yellow statuses and the regulations/recommendations fields
// that compliance_check.py appends only when status ∈ {red, yellow}.
// ---------------------------------------------------------------------------

const withFailures = {
  ...NARROW_FLOOR_PLAN,

  objects: [
    {
      id:           'toilet_1',
      type:         'toilet',
      confidence:   0.851,
      // Seat top (bbox max Y) = 0.612m; 0.612 > 0.60 → subtract 0.20 → 0.412m
      // 0.412 < 0.430 → red ✓
      position:     [-0.42, 0.0, 0.35],
      bbox_aligned: {
        min: [-0.64, -0.02, 0.11],
        max: [-0.20,  0.612, 0.59],
      },
      support_plane: 'floor',
      evidence: {
        num_points:    134,
        num_detections: 11,
        image_names:   ['frame_0009.jpg', 'frame_0017.jpg', 'frame_0025.jpg'],
      },
    },
    {
      id:           'grab_handle_1',
      type:         'grab_handle',
      confidence:   0.742,
      // is_obstructed is hardcoded False in extractor — the grab_bar_obstruction
      // fixture shows true to illustrate what a failing report looks like.
      // In practice this field would come from a more advanced detection step.
      position:     [-0.79, 0.852, 0.30],
      bbox_aligned: {
        min: [-0.80, 0.798, 0.08],
        max: [-0.78, 0.906, 0.52],
      },
      support_plane: 'wall_west',
      evidence: {
        num_points:    31,
        num_detections: 6,
        image_names:   ['frame_0004.jpg', 'frame_0018.jpg'],
      },
    },
    {
      // soap dispenser — detected, height out of range
      id:           'soap_1',
      type:         'soap',
      confidence:   0.688,
      // Centroid Y = 1.35m → > 1.220m → red for ToilerPaper_height check
      position:     [0.75, 1.35, -0.68],
      bbox_aligned: {
        min: [0.70, 1.29, -0.74],
        max: [0.80, 1.41, -0.62],
      },
      support_plane: 'wall_east',
      evidence: {
        num_points:    18,
        num_detections: 4,
        image_names:   ['frame_0006.jpg', 'frame_0022.jpg'],
      },
    },
    {
      id:           'emergency_button_1',
      type:         'emergency_button',
      confidence:   0.793,
      // Centroid Y = 0.620m → < 0.700m → red ✓
      position:     [-0.10, 0.620, -0.68],
      bbox_aligned: {
        min: [-0.16, 0.585, -0.73],
        max: [-0.04, 0.655, -0.63],
      },
      support_plane: 'wall_south',
      evidence: {
        num_points:    14,
        num_detections: 3,
        image_names:   ['frame_0011.jpg'],
      },
    },
  ],

  objects_meta: {
    source:               'step3_detect_items',
    floor_alignment_json: 'floor_alignment.json',
  },

  compliance_report: [
    {
      test_id:         'turning_radius',
      name:            'Turning Diameter',
      target_object:   'room_clearance',
      measured_value:  1.31,
      status:          'red',
      message:         'Non-Compliant / Barrier Detected',
      regulations:     'A 1500mm diameter circle must be free of obstructions.',
      recommendations: 'Remove obstructions (furniture, bins) to ensure a full 1.5m diameter turning circle is clear.',
    },
    {
      test_id:         'toilet_seat_height',
      name:            'Toilet Seat Height',
      target_object:   'toilet',
      measured_value:  0.412,
      status:          'red',
      message:         'Non-Compliant / Barrier Detected',
      regulations:     'The top of the seat must be between 430mm and 485mm from the floor.',
      recommendations: 'Adjust toilet height. If too low, install a seat riser or plinth. If too high, adjust floor or replace unit.',
    },
    {
      // door_width: measured 0.882m → 0.864 ≤ 0.882 ≤ 0.914 → yellow
      test_id:         'door_width',
      name:            'Door Clear Width',
      target_object:   'door',
      measured_value:  0.882,
      status:          'yellow',
      message:         'Compliant (Minimum Standard)',
      regulations:     'Minimum clear width is 864mm. Best practice is 915mm.',
      recommendations: "Widen the doorway. If structural changes are difficult, consider offset 'swing-clear' hinges to gain width.",
    },
    {
      // grab_bar_obstruction: measured true → red
      test_id:         'grab_bar_obstruction',
      name:            'Grab Bar Obstruction Check',
      target_object:   'grab_bar',
      measured_value:  true,
      status:          'red',
      message:         'Non-Compliant / Barrier Detected',
      regulations:     'Dispensers or bins must not be mounted above or near the grab bar.',
      recommendations: 'Relocate the dispenser, bin, or accessory causing the obstruction away from the grab bar zone.',
    },
    {
      // ToilerPaper_height: soap centroid Y = 1.35m → > 1.219m → red
      test_id:         'ToilerPaper_height',
      name:            'Toiler Paper Dispenser Controls Height',
      target_object:   'dispenser',
      measured_value:  1.35,
      status:          'red',
      message:         'Non-Compliant / Barrier Detected',
      regulations:     'Operable parts must be between 380-1220 mm.',
      recommendations: 'Relocate the toilet paper dispenser to the compliant height range (380mm - 1220mm).',
    },
    {
      // dispenser_height: same dispenser, 1.35m → > 1.220m → red
      test_id:         'dispenser_height',
      name:            'Dispenser Controls Height',
      target_object:   'dispenser',
      measured_value:  1.35,
      status:          'red',
      message:         'Non-Compliant / Barrier Detected',
      regulations:     'Operable parts must be between 1120mm and 1220mm.',
      recommendations: 'Adjust the mounting height of the dispenser so operable parts are between 1120mm and 1220mm.',
    },
    {
      // emergency_button_height: centroid Y = 0.620m → < 0.700m → red
      test_id:         'emergency_button_height',
      name:            'Emergency Button Position',
      target_object:   'emergency_button',
      measured_value:  0.62,
      status:          'red',
      message:         'Non-Compliant / Barrier Detected',
      regulations:     'Button must be mounted between 700mm and 1200mm from the floor.',
      recommendations: 'Relocate the emergency call button to be within 700mm to 1200mm from the floor.',
    },
  ],

  world_state_debug: {
    toilet: {
      position: [-0.42, 0.0, 0.35],
      height_m: 0.412,
    },
    grab_bar: {
      position:              [-0.79, 0.852, 0.30],
      height_m:              0.852,
      distance_to_toilet_m:  0.387,
      is_obstructed:         true,
    },
    dispenser: {
      position: [0.75, 1.35, -0.68],
      height_m: 1.35,
    },
    emergency_button: {
      position: [-0.10, 0.620, -0.68],
      height_m: 0.620,
    },
    door: {
      position: null,
      width_m:  0.882,
    },
    room_clearance: {
      diameter_m: 1.31,
    },
  },
};

// ---------------------------------------------------------------------------
// Fixture 3 — noObjectsDetected
// COLMAP produced geometry (floor + walls) but YOLO found nothing.
// All compliance items are "unknown" with the "Object '...' not found" message.
// Represents a scan where the camera moved too fast or the model had
// insufficient overlap to detect bathroom fixtures.
// ---------------------------------------------------------------------------

const noObjectsDetected = {
  ...STANDARD_FLOOR_PLAN,

  objects:      [],
  objects_meta: {
    source:               'step3_detect_items',
    floor_alignment_json: 'floor_alignment.json',
  },

  compliance_report: [
    {
      test_id:       'turning_radius',
      name:          'Turning Diameter',
      target_object: 'room_clearance',
      // No objects → no obstacle subtraction; diameter = min(room_w, room_d) = 2.00m
      // 2.00 > 1.50 → green (footprint alone is compliant)
      measured_value: 2.0,
      status:        'green',
      message:       'Compliant (Best Practice)',
    },
    {
      test_id:       'toilet_seat_height',
      name:          'Toilet Seat Height',
      target_object: 'toilet',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'toilet' not found",
    },
    {
      test_id:       'door_width',
      name:          'Door Clear Width',
      target_object: 'door',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'door' not found",
    },
    {
      test_id:       'grab_bar_obstruction',
      name:          'Grab Bar Obstruction Check',
      target_object: 'grab_bar',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'grab_bar' not found",
    },
    {
      test_id:       'ToilerPaper_height',
      name:          'Toiler Paper Dispenser Controls Height',
      target_object: 'dispenser',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'dispenser' not found",
    },
    {
      test_id:       'dispenser_height',
      name:          'Dispenser Controls Height',
      target_object: 'dispenser',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'dispenser' not found",
    },
    {
      test_id:       'emergency_button_height',
      name:          'Emergency Button Position',
      target_object: 'emergency_button',
      measured_value: null,
      status:        'unknown',
      message:       "Object 'emergency_button' not found",
    },
  ],

  world_state_debug: {
    toilet:           { position: null, height_m: null },
    grab_bar:         { position: null, height_m: null, distance_to_toilet_m: null, is_obstructed: false },
    dispenser:        { position: null, height_m: null },
    emergency_button: { position: null, height_m: null },
    door:             { position: null, width_m: null },
    room_clearance:   { diameter_m: 2.0 },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a minimal Blob-like whose .text() resolves to the serialised fixture.
 * Used to stub supabase.storage.from().download() in pipeline callback tests.
 *
 * @param {object} sceneJsonObj - One of the exports from this file.
 * @returns {{ text: () => Promise<string> }}
 */
function asBlob(sceneJsonObj) {
  const serialised = JSON.stringify(sceneJsonObj);
  return { text: () => Promise.resolve(serialised) };
}

/**
 * Returns a successful Supabase download response wrapping a scene.json fixture.
 *
 * @param {object} sceneJsonObj
 * @returns {{ data: object, error: null }}
 */
function asDownloadResult(sceneJsonObj) {
  return { data: asBlob(sceneJsonObj), error: null };
}

module.exports = {
  fullyCompliant,
  withFailures,
  noObjectsDetected,
  asBlob,
  asDownloadResult,
};