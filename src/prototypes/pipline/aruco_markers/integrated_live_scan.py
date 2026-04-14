import cv2
import numpy as np
import os
import json
from datetime import datetime

# ===================== YOLO IMPORT =====================

try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    YOLO = None

# ===================== PATHS / CONFIG =====================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Camera calibration file (Charuco)
CALIB_PATH = os.path.join(BASE_DIR, "calibration_charuco.npz")

# ArUco settings
ARUCO_DICT_NAME = cv2.aruco.DICT_4X4_50
MARKER_SIZE_M = 0.096  # 9.6 cm markers

# YOLO
YOLO_WEIGHTS = os.path.join(BASE_DIR, "best.pt")
YOLO_CLASS_NAMES = [
    "toilet",          # 0
    "grab_handle",     # 1
    "mirror",          # 2
    "sink",            # 3
    "soap",            # 4
    "towel",           # 5
    "wheelchair_logo", # 6
    "door-handle"      # 7
]

# Edge detection parameters
CANNY_LOW = 50
CANNY_HIGH = 150
HOUGH_THRESH = 80
MIN_LINE_LENGTH = 50
MAX_LINE_GAP = 10

# Outputs
OUT_TRAJ_NPY = os.path.join(BASE_DIR, "camera_trajectory.npy")
OUT_SUMMARY_JSON = os.path.join(BASE_DIR, "scan_summary.json")


# ===================== UTILS =====================

def load_calibration(calib_path=CALIB_PATH):
    """
    Load camera intrinsics from Charuco calibration file.

    Supports both:
      - 'cameraMatrix', 'distCoeffs'
      - 'camera_matrix', 'dist_coeffs'
    """
    if not os.path.exists(calib_path):
        raise FileNotFoundError(f"Calibration file not found: {calib_path}")

    data = np.load(calib_path)

    if "cameraMatrix" in data and "distCoeffs" in data:
        K = data["cameraMatrix"]
        dist = data["distCoeffs"]
    else:
        K = data["camera_matrix"]
        dist = data["dist_coeffs"]

    return K, dist


def init_aruco():
    aruco_dict = cv2.aruco.getPredefinedDictionary(ARUCO_DICT_NAME)
    aruco_params = cv2.aruco.DetectorParameters()
    return aruco_dict, aruco_params


def detect_aruco_multimarker(
    frame,
    aruco_dict,
    aruco_params,
    camera_matrix,
    dist_coeffs,
    marker_length=MARKER_SIZE_M,
    ref_marker_id=None,
    marker_world_poses=None,
):
    """
    Multi-marker detection + auto switch-back.

    - If ref_marker_id is None and any markers are seen, choose the first as reference.
    - When ref marker is visible, compute camera pose from it (world = ref frame) and
      update world poses for all visible markers.
    - When ref is NOT visible but another marker with a known world pose is visible,
      compute camera pose from that marker (auto switch-back).
    - If no marker with known world pose is visible, no pose is returned.

    Returns:
      R_wc (3x3) or None
      t_wc (3x1) or None
      frame_out (BGR) with markers + axes + ref text
      ref_marker_id (possibly newly set)
      ref_visible (bool)
      pose_marker_id (int or None) - which marker was used for pose
      marker_world_poses (dict[int -> {"R": R_wm, "t": t_wm}])
    """
    if marker_world_poses is None:
        marker_world_poses = {}

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    corners, ids, _ = cv2.aruco.detectMarkers(gray, aruco_dict, parameters=aruco_params)

    frame_out = frame
    R_wc = None
    t_wc = None
    ref_visible = False
    pose_marker_id = None

    if ids is None or len(ids) == 0:
        # No markers: draw status text and return
        if ref_marker_id is None:
            text = "Reference marker: NOT YET SELECTED"
        else:
            text = f"Ref ID {ref_marker_id}: NOT VISIBLE (no markers)"
        cv2.putText(
            frame_out, text, (10, 25),
            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2
        )
        return R_wc, t_wc, frame_out, ref_marker_id, ref_visible, pose_marker_id, marker_world_poses

    # Draw all detected markers
    cv2.aruco.drawDetectedMarkers(frame_out, corners, ids)
    ids_flat = ids.flatten().astype(int)

    # Pose per marker (camera-from-marker)
    rvecs, tvecs, _obj_points = cv2.aruco.estimatePoseSingleMarkers(
        corners, marker_length, camera_matrix, dist_coeffs
    )

    # If we don't yet have a reference marker, choose the first one we see
    if ref_marker_id is None:
        ref_marker_id = int(ids_flat[0])
        print(f"[INFO] Selected marker {ref_marker_id} as world reference.")

    # Check if reference is visible this frame
    if ref_marker_id in ids_flat:
        ref_visible = True
        # Index of ref marker in this detection
        idx_ref = int(np.where(ids_flat == ref_marker_id)[0][0])

        # Pose of ref marker relative to camera
        rvec_ref = rvecs[idx_ref]
        tvec_ref = tvecs[idx_ref]

        # Draw axis on the reference marker
        cv2.drawFrameAxes(
            frame_out,
            camera_matrix,
            dist_coeffs,
            rvec_ref,
            tvec_ref,
            marker_length * 0.5,
        )

        # Convert to rotation matrix
        R_cm_ref, _ = cv2.Rodrigues(rvec_ref)  # cam-from-refMarker
        t_cm_ref = tvec_ref.reshape(3, 1)

        # Camera pose in world = ref marker frame
        # X_cam = R_cm_ref * X_world + t_cm_ref  (world == ref marker)
        # => X_world = R_wc * X_cam + t_wc
        # => R_wc = R_cm_ref^T, t_wc = -R_cm_ref^T * t_cm_ref
        R_wc = R_cm_ref.T
        t_wc = -R_wc @ t_cm_ref
        pose_marker_id = ref_marker_id

        # World pose of reference marker = identity
        marker_world_poses[ref_marker_id] = {
            "R": np.eye(3),
            "t": np.zeros((3, 1))
        }

        # Update world poses for all visible markers using this camera pose
        for i, mid in enumerate(ids_flat):
            rvec_m = rvecs[i]
            tvec_m = tvecs[i]
            R_cm_m, _ = cv2.Rodrigues(rvec_m)
            t_cm_m = tvec_m.reshape(3, 1)

            # Marker pose in world:
            # X_cam = R_cm_m * X_marker + t_cm_m
            # X_world = R_wc * X_cam + t_wc
            # => X_world = (R_wc * R_cm_m) X_marker + (R_wc * t_cm_m + t_wc)
            R_wm = R_wc @ R_cm_m
            t_wm = R_wc @ t_cm_m + t_wc

            marker_world_poses[int(mid)] = {
                "R": R_wm,
                "t": t_wm
            }

    else:
        # Reference marker not visible: try fallback markers with known world pose
        for i, mid in enumerate(ids_flat):
            mid_int = int(mid)
            if mid_int not in marker_world_poses:
                continue  # no mapping for this marker yet

            # Known world pose of this marker
            R_wm = marker_world_poses[mid_int]["R"]
            t_wm = marker_world_poses[mid_int]["t"]

            # Current measurement: marker pose relative to camera
            rvec_m = rvecs[i]
            tvec_m = tvecs[i]
            R_cm_m, _ = cv2.Rodrigues(rvec_m)
            t_cm_m = tvec_m.reshape(3, 1)

            # We know:
            # X_cam = R_cm_m * X_marker + t_cm_m
            # X_world = R_wm * X_marker + t_wm
            # Also X_world = R_wc * X_cam + t_wc
            # =>
            # R_wc * R_cm_m = R_wm  => R_wc = R_wm * R_cm_m^T
            R_wc_candidate = R_wm @ R_cm_m.T
            # =>
            # R_wc * t_cm_m + t_wc = t_wm => t_wc = t_wm - R_wc * t_cm_m
            t_wc_candidate = t_wm - R_wc_candidate @ t_cm_m

            R_wc = R_wc_candidate
            t_wc = t_wc_candidate
            pose_marker_id = mid_int
            break  # use first valid fallback

    # Overlay reference marker info text
    if ref_marker_id is None:
        text = "Reference marker: NOT YET SELECTED"
        color = (0, 0, 255)
    else:
        if pose_marker_id is None:
            status = "NOT VISIBLE (no mapped fallback)"
            color = (0, 0, 255)
        elif pose_marker_id == ref_marker_id:
            status = "VISIBLE (using ref)"
            color = (0, 255, 0)
        else:
            status = f"NOT VISIBLE (using marker {pose_marker_id})"
            color = (0, 255, 255)
        text = f"Ref ID {ref_marker_id}: {status}"

    cv2.putText(
        frame_out,
        text,
        (10, 25),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        color,
        2,
    )

    return R_wc, t_wc, frame_out, ref_marker_id, ref_visible, pose_marker_id, marker_world_poses


def load_yolo_model(weights_path=YOLO_WEIGHTS):
    if not YOLO_AVAILABLE:
        print("[YOLO] ultralytics not installed; skipping YOLO.")
        return None

    if not os.path.exists(weights_path):
        print(f"[YOLO] Weights not found at {weights_path}. YOLO disabled.")
        return None

    print(f"[YOLO] Loading model from {weights_path} ...")
    model = YOLO(weights_path)
    print("[YOLO] Model loaded.")
    return model


def run_yolo_detection(model, frame, conf_thresh=0.5):
    """
    Runs YOLO on a BGR frame and returns list of detections.
    """
    if model is None:
        return []

    results = model(frame, imgsz=640, verbose=False)[0]
    dets = []

    if results.boxes is None:
        return dets

    for box in results.boxes:
        cls_id = int(box.cls.item())
        conf = float(box.conf.item())
        if conf < conf_thresh:
            continue

        x1, y1, x2, y2 = box.xyxy[0].tolist()
        cx = 0.5 * (x1 + x2)
        cy = 0.5 * (y1 + y2)

        class_name = (
            YOLO_CLASS_NAMES[cls_id]
            if 0 <= cls_id < len(YOLO_CLASS_NAMES)
            else str(cls_id)
        )

        dets.append(
            {
                "class_id": cls_id,
                "class_name": class_name,
                "conf": conf,
                "bbox_xyxy": [float(x1), float(y1), float(x2), float(y2)],
                "pixel_center": [float(cx), float(cy)],
            }
        )

    return dets


def detect_structural_edges(frame):
    """
    Canny + Hough to find:
      - door_lines: vertical-ish segments (door edges)
      - floor_line: strongest horizontal-ish segment near bottom (wall/floor boundary)
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, CANNY_LOW, CANNY_HIGH)

    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=HOUGH_THRESH,
        minLineLength=MIN_LINE_LENGTH,
        maxLineGap=MAX_LINE_GAP,
    )

    door_lines = []
    floor_line = None

    if lines is not None:
        h, w = gray.shape
        vertical_tol = 10  # degrees
        horiz_tol = 10     # degrees

        best_floor_score = -1
        best_floor_line = None

        for l in lines:
            x1, y1, x2, y2 = l[0]
            dx = x2 - x1
            dy = y2 - y1
            length = np.hypot(dx, dy)
            if length < MIN_LINE_LENGTH:
                continue

            angle = np.degrees(np.arctan2(dy, dx))

            # Door edges: near-vertical
            if abs(90 - abs(angle)) < vertical_tol:
                x_center = (x1 + x2) / 2
                if w * 0.05 < x_center < w * 0.95:
                    door_lines.append(
                        ((int(x1), int(y1)), (int(x2), int(y2)))
                    )

            # Floor-wall boundary: strong horizontal near bottom
            if abs(angle) < horiz_tol:
                y_center = (y1 + y2) / 2
                bottom_proximity = y_center / h
                score = length * bottom_proximity
                if score > best_floor_score:
                    best_floor_score = score
                    best_floor_line = (
                        (int(x1), int(y1)),
                        (int(x2), int(y2)),
                    )

        floor_line = best_floor_line

    return {
        "edges": edges,
        "door_lines": door_lines,
        "floor_line": floor_line,
    }


def compute_ray_from_pixel(pixel, camera_matrix, R_wc, t_wc):
    """
    Given pixel + camera pose, compute a world-space ray.
    """
    u, v = pixel
    K = camera_matrix
    K_inv = np.linalg.inv(K)

    uv1 = np.array([u, v, 1.0], dtype=np.float32)
    ray_dir_cam = K_inv @ uv1
    ray_dir_cam = ray_dir_cam / np.linalg.norm(ray_dir_cam)

    ray_origin_world = t_wc.reshape(3)
    ray_dir_world = R_wc @ ray_dir_cam
    ray_dir_world = ray_dir_world / np.linalg.norm(ray_dir_world)

    return ray_origin_world.tolist(), ray_dir_world.tolist()


def draw_overlay(
    frame_with_markers,
    yolo_dets,
    edge_info,
    captured_frame_idx,
    poses_with_ref,
    poses_with_alt,
    has_pose,
    pose_marker_id,
    ref_marker_id
):
    """
    Draw YOLO boxes + door lines + floor line + counters + colored border.
    """
    vis = frame_with_markers

    # YOLO detections
    for det in yolo_dets:
        x1, y1, x2, y2 = map(int, det["bbox_xyxy"])
        cls_name = det["class_name"]
        conf = det["conf"]
        cv2.rectangle(vis, (x1, y1), (x2, y2), (0, 255, 0), 2)
        label = f"{cls_name} {conf:.2f}"
        cv2.putText(
            vis,
            label,
            (x1, max(0, y1 - 5)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 255, 0),
            1,
        )

    # Door lines (magenta)
    for (p1, p2) in edge_info.get("door_lines", []):
        cv2.line(vis, p1, p2, (255, 0, 255), 2)

    # Floor line (cyan)
    floor_line = edge_info.get("floor_line")
    if floor_line is not None:
        cv2.line(vis, floor_line[0], floor_line[1], (255, 255, 0), 3)

    # Counters text
    cv2.putText(
        vis,
        f"Frames: {captured_frame_idx} | Poses ref: {poses_with_ref} | Poses alt: {poses_with_alt}",
        (10, 50),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (255, 255, 255),
        2,
    )

    # Border color:
    #   green  = pose from reference marker
    #   yellow = pose from non-reference marker
    #   red    = no pose
    h, w = vis.shape[:2]
    if not has_pose:
        border_color = (0, 0, 255)
    else:
        if pose_marker_id == ref_marker_id:
            border_color = (0, 255, 0)
        else:
            border_color = (0, 255, 255)

    cv2.rectangle(vis, (0, 0), (w - 1, h - 1), border_color, 3)

    return vis


# ===================== MAIN PIPELINE =====================

def main():
    camera_matrix, dist_coeffs = load_calibration()
    aruco_dict, aruco_params = init_aruco()
    yolo_model = load_yolo_model()

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Could not open camera.")
        return

    camera_poses = []
    frames_log = []

    frame_idx = 0
    poses_with_ref = 0
    poses_with_alt = 0
    ref_marker_id = None
    marker_world_poses = {}

    captured_frame_idx = 0

    print("Starting integrated live scan (auto switch-back). Press ESC to quit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Frame grab failed; stopping.")
            break

        timestamp = datetime.now().isoformat()

        # 1) Multi-marker ArUco with auto switch-back
        R_wc, t_wc, frame_with_markers, ref_marker_id, ref_visible, pose_marker_id, marker_world_poses = (
            detect_aruco_multimarker(
                frame.copy(),
                aruco_dict,
                aruco_params,
                camera_matrix,
                dist_coeffs,
                marker_length=MARKER_SIZE_M,
                ref_marker_id=ref_marker_id,
                marker_world_poses=marker_world_poses,
            )
        )

        has_pose = R_wc is not None and t_wc is not None

        pose_index = None
        if has_pose:
            pose_index = len(camera_poses)
            camera_poses.append(
                {"R": R_wc.tolist(), "t": t_wc.reshape(3).tolist()}
            )
            if pose_marker_id == ref_marker_id:
                poses_with_ref += 1
            else:
                poses_with_alt += 1

        # 2) YOLO detections
        yolo_dets = run_yolo_detection(yolo_model, frame)

        # 3) Attach world-space rays if pose valid
        if has_pose:
            for det in yolo_dets:
                origin, direction = compute_ray_from_pixel(
                    det["pixel_center"], camera_matrix, R_wc, t_wc
                )
                det["ray_origin_world"] = origin
                det["ray_dir_world"] = direction
        else:
            for det in yolo_dets:
                det["ray_origin_world"] = None
                det["ray_dir_world"] = None

        # 4) Edge detection
        edge_info = detect_structural_edges(frame)

        # 5) Visualization
        vis = draw_overlay(
            frame_with_markers,
            yolo_dets,
            edge_info,
            captured_frame_idx,
            poses_with_ref,
            poses_with_alt,
            has_pose,
            pose_marker_id,
            ref_marker_id,
        )
        cv2.imshow("Integrated Live Scan (ArUco + YOLO + Edges)", vis)

        # 6) Log frame data
        if has_pose:
            frames_log.append(
                {
                    "frame_index": captured_frame_idx,
                    "timestamp": timestamp,
                    "has_pose": True,
                    "pose_index": pose_index,
                    "ref_marker_id": ref_marker_id,
                    "pose_marker_id": pose_marker_id,
                    "yolo_detections": yolo_dets,
                    "door_lines": edge_info.get("door_lines", []),
                    "floor_line": edge_info.get("floor_line", None),
                }
            )
            captured_frame_idx += 1

        frame_idx += 1

        key = cv2.waitKey(1) & 0xFF
        if key == 27:  # ESC
            print("ESC pressed; stopping.")
            break

    cap.release()
    cv2.destroyAllWindows()

    # Save camera trajectory
    np.save(
        OUT_TRAJ_NPY,
        np.array(
            [{"R": pose["R"], "t": pose["t"]} for pose in camera_poses],
            dtype=object,
        ),
        allow_pickle=True,
    )

    # Build scan summary JSON
    scan_summary = {
        "config": {
            "calibration_path": CALIB_PATH,
            "aruco_dict": int(ARUCO_DICT_NAME),
            "marker_size_m": MARKER_SIZE_M,
            "yolo_weights": YOLO_WEIGHTS if yolo_model is not None else None,
            "yolo_classes": YOLO_CLASS_NAMES,
        },
        "num_frames": len(frames_log),
        "num_camera_poses": len(camera_poses),
        "camera_poses": camera_poses,
        "frames": frames_log,
    }

    with open(OUT_SUMMARY_JSON, "w") as f:
        json.dump(scan_summary, f, indent=2)

    print(f"Saved camera trajectory to {OUT_TRAJ_NPY}")
    print(f"Saved scan summary to {OUT_SUMMARY_JSON}")


if __name__ == "__main__":
    main()
