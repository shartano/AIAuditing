#!/usr/bin/env python3
r"""
Step 4: Metric scaling from an ArUco marker using COLMAP (text) reconstruction.

What it does (end-to-end):
1) Detect ArUco marker corners in your frames (OpenCV aruco).
2) Read COLMAP text outputs: cameras.txt + images.txt (+ optional points3D.txt not required).
3) Multi-view triangulate the 4 marker corners in COLMAP world coordinates using COLMAP camera poses.
4) Robustly compute marker edge length in COLMAP units (median of edges; with reprojection outlier filtering).
5) Compute meters_per_colmap_unit = marker_size_m / measured_edge_colmap
6) Update scene.json:
   - writes the scale metadata
   - scales common geometry fields (positions, bbox, plane offsets, etc.) conservatively

Run (example, Windows PowerShell):
  python step4_scale_aruco.py    --colmap_text ..\projects\seb1\seb1_text    --images_dir ..\projects\seb1\seb1_images    --scene_in out\scene.json    --scene_out out\scene_scaled.json    --marker_size_m 0.096    --aruco_dict DICT_4X4_50    --marker_id 22 --fail_on_warning

Notes:
- Requires OpenCV with aruco (opencv-contrib-python).
- If you’re unsure about marker_id, set --marker_id -1 to accept ANY id (not recommended long-term).
"""

import argparse
import json
import math
import os
from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional, Any

import numpy as np
import cv2


# -----------------------------
# COLMAP parsing (text)
# -----------------------------
@dataclass
class ColmapCamera:
    camera_id: int
    model: str
    width: int
    height: int
    params: List[float]  # model-specific


@dataclass
class ColmapImage:
    image_id: int
    qvec: np.ndarray  # (4,) wxyz
    tvec: np.ndarray  # (3,)
    camera_id: int
    name: str


def _qvec_to_rotmat(qvec_wxyz: np.ndarray) -> np.ndarray:
    """
    COLMAP qvec is (qw, qx, qy, qz) representing world-to-camera rotation.
    Returns R (3x3) such that x_cam = R * x_world + t
    """
    qw, qx, qy, qz = qvec_wxyz.tolist()
    # Standard quaternion -> rotation matrix
    R = np.array([
        [1 - 2*qy*qy - 2*qz*qz, 2*qx*qy - 2*qz*qw,     2*qx*qz + 2*qy*qw],
        [2*qx*qy + 2*qz*qw,     1 - 2*qx*qx - 2*qz*qz, 2*qy*qz - 2*qx*qw],
        [2*qx*qz - 2*qy*qw,     2*qy*qz + 2*qx*qw,     1 - 2*qx*qx - 2*qy*qy],
    ], dtype=np.float64)
    return R


def load_cameras_txt(path: str) -> Dict[int, ColmapCamera]:
    cams: Dict[int, ColmapCamera] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            camera_id = int(parts[0])
            model = parts[1]
            width = int(parts[2])
            height = int(parts[3])
            params = list(map(float, parts[4:]))
            cams[camera_id] = ColmapCamera(camera_id, model, width, height, params)
    if not cams:
        raise RuntimeError(f"No cameras parsed from {path}")
    return cams


def load_images_txt(path: str) -> Dict[int, ColmapImage]:
    """
    images.txt structure:
    # Image list with two lines per image:
    # IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME
    # POINTS2D[] (ignored here)
    """
    imgs: Dict[int, ColmapImage] = {}
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 10:
            raise RuntimeError(f"Malformed images.txt line: {line}")

        image_id = int(parts[0])
        qvec = np.array(list(map(float, parts[1:5])), dtype=np.float64)  # qw qx qy qz
        tvec = np.array(list(map(float, parts[5:8])), dtype=np.float64)  # tx ty tz
        camera_id = int(parts[8])
        name = " ".join(parts[9:])  # in case of spaces (rare)

        imgs[image_id] = ColmapImage(image_id, qvec, tvec, camera_id, name)

        # skip points2D line
        if i < len(lines):
            i += 1

    if not imgs:
        raise RuntimeError(f"No images parsed from {path}")
    return imgs


def build_intrinsics(camera: ColmapCamera) -> Tuple[np.ndarray, np.ndarray]:
    """
    Returns (K, dist) where dist is OpenCV distortion coefficients.
    For models without distortion, dist = zeros.
    Supports common models: SIMPLE_PINHOLE, PINHOLE, SIMPLE_RADIAL, RADIAL, OPENCV.
    """
    model = camera.model.upper()
    p = camera.params

    # Default: no distortion
    dist = np.zeros((5,), dtype=np.float64)

    if model == "SIMPLE_PINHOLE":
        # f, cx, cy
        f, cx, cy = p
        fx = fy = f
    elif model == "PINHOLE":
        # fx, fy, cx, cy
        fx, fy, cx, cy = p
    elif model == "SIMPLE_RADIAL":
        # f, cx, cy, k
        f, cx, cy, k1 = p
        fx = fy = f
        dist = np.array([k1, 0.0, 0.0, 0.0, 0.0], dtype=np.float64)
    elif model == "RADIAL":
        # f, cx, cy, k1, k2
        f, cx, cy, k1, k2 = p
        fx = fy = f
        dist = np.array([k1, k2, 0.0, 0.0, 0.0], dtype=np.float64)
    elif model == "OPENCV":
        # fx, fy, cx, cy, k1, k2, p1, p2
        fx, fy, cx, cy, k1, k2, p1, p2 = p
        dist = np.array([k1, k2, p1, p2, 0.0], dtype=np.float64)
    elif model == "OPENCV_FISHEYE":
        # fx, fy, cx, cy, k1, k2, k3, k4  (we'll store in a 4-vector; handle separately)
        fx, fy, cx, cy, k1, k2, k3, k4 = p
        dist = np.array([k1, k2, k3, k4], dtype=np.float64)  # fisheye
    else:
        raise NotImplementedError(f"Unsupported COLMAP camera model: {camera.model}")

    K = np.array([[fx, 0.0, cx],
                  [0.0, fy, cy],
                  [0.0, 0.0, 1.0]], dtype=np.float64)
    return K, dist


def projection_matrix(K: np.ndarray, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    Rt = np.hstack([R, t.reshape(3, 1)])
    return K @ Rt


# -----------------------------
# ArUco detection
# -----------------------------
ARUCO_DICT_MAP = {
    "DICT_4X4_50": cv2.aruco.DICT_4X4_50,
    "DICT_4X4_100": cv2.aruco.DICT_4X4_100,
    "DICT_4X4_250": cv2.aruco.DICT_4X4_250,
    "DICT_4X4_1000": cv2.aruco.DICT_4X4_1000,
    "DICT_5X5_50": cv2.aruco.DICT_5X5_50,
    "DICT_5X5_100": cv2.aruco.DICT_5X5_100,
    "DICT_5X5_250": cv2.aruco.DICT_5X5_250,
    "DICT_5X5_1000": cv2.aruco.DICT_5X5_1000,
    "DICT_6X6_50": cv2.aruco.DICT_6X6_50,
    "DICT_6X6_100": cv2.aruco.DICT_6X6_100,
    "DICT_6X6_250": cv2.aruco.DICT_6X6_250,
    "DICT_6X6_1000": cv2.aruco.DICT_6X6_1000,
    "DICT_7X7_50": cv2.aruco.DICT_7X7_50,
    "DICT_7X7_100": cv2.aruco.DICT_7X7_100,
    "DICT_7X7_250": cv2.aruco.DICT_7X7_250,
    "DICT_7X7_1000": cv2.aruco.DICT_7X7_1000,
}


def detect_aruco_in_images(
    images_dir: str,
    colmap_images: Dict[int, ColmapImage],
    aruco_dict_name: str,
    marker_id: int,
    min_side_px: float = 50.0,
) -> Dict[str, Any]:
    """
    Returns observation json-like dict:
      {aruco_dict, marker_id, detections:[{image_name,image_id,marker_id,corners_px,side_px,image_wh}]}

    Important robustness:
    - If marker_id == -1, we first collect all detections, then KEEP ONLY the most frequent marker id.
    - We store the source image width/height so later we can rescale corners to COLMAP camera resolution if needed.
    """
    if aruco_dict_name not in ARUCO_DICT_MAP:
        raise ValueError(f"Unknown aruco dict '{aruco_dict_name}'. Options: {list(ARUCO_DICT_MAP.keys())}")

    name_to_id = {img.name.replace("\\", "/").split("/")[-1]: img_id for img_id, img in colmap_images.items()}

    aruco_dict = cv2.aruco.getPredefinedDictionary(ARUCO_DICT_MAP[aruco_dict_name])
    params = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(aruco_dict, params)

    raw_detections = []
    img_files = sorted([
        f for f in os.listdir(images_dir)
        if f.lower().endswith((".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"))
    ])

    for fname in img_files:
        path = os.path.join(images_dir, fname)
        im = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if im is None:
            continue

        h, w = im.shape[:2]

        corners_list, ids, _rej = detector.detectMarkers(im)
        if ids is None or len(ids) == 0:
            continue

        ids = ids.flatten().astype(int)
        for corners, mid in zip(corners_list, ids):
            # If marker_id is specified (>=0), filter immediately.
            if marker_id != -1 and mid != marker_id:
                continue

            c = np.array(corners, dtype=np.float64).reshape(-1, 2)
            if c.shape != (4, 2):
                continue

            d01 = np.linalg.norm(c[0] - c[1])
            d12 = np.linalg.norm(c[1] - c[2])
            d23 = np.linalg.norm(c[2] - c[3])
            d30 = np.linalg.norm(c[3] - c[0])
            side_px = float(np.median([d01, d12, d23, d30]))

            if side_px < min_side_px:
                continue

            if fname not in name_to_id:
                continue

            raw_detections.append({
                "image_name": fname,
                "image_id": int(name_to_id[fname]),
                "marker_id": int(mid),
                "corners_px": c.tolist(),
                "side_px": side_px,
                "image_wh": [int(w), int(h)],
            })

    # If marker_id == -1, choose the most frequent ID and keep only those detections.
    chosen_id = marker_id
    if marker_id == -1:
        if not raw_detections:
            return {"aruco_dict": aruco_dict_name, "marker_id": -1, "detections": []}
        ids_all = [d["marker_id"] for d in raw_detections]
        # most common
        chosen_id = int(max(set(ids_all), key=ids_all.count))
        raw_detections = [d for d in raw_detections if d["marker_id"] == chosen_id]
        print(f"[Step4] marker_id=-1 -> using most frequent marker id = {chosen_id} (kept {len(raw_detections)} detections)")

    return {
        "aruco_dict": aruco_dict_name,
        "marker_id": int(chosen_id),
        "detections": raw_detections,
    }



# -----------------------------
# Triangulation (multi-view DLT + reprojection filtering)
# -----------------------------
def undistort_points(
    pts_px: np.ndarray, K: np.ndarray, dist: np.ndarray, model: str
) -> np.ndarray:
    """
    pts_px: (N,2) pixel points
    returns normalized undistorted points in pixel coords (back-projected into image plane).
    We'll keep triangulation in pixel coordinates using P = K[R|t] by undistorting to ideal pixels.
    """
    model_u = model.upper()
    pts = pts_px.reshape(-1, 1, 2).astype(np.float64)

    if model_u == "OPENCV_FISHEYE":
        # fisheye undistort -> normalized
        und = cv2.fisheye.undistortPoints(pts, K, dist)
        # und is normalized (x,y). Convert back to pixels using K
        und = und.reshape(-1, 2)
        pts_px_ideal = (K @ np.hstack([und, np.ones((und.shape[0], 1))]).T).T
        pts_px_ideal = pts_px_ideal[:, :2] / pts_px_ideal[:, 2:3]
        return pts_px_ideal
    else:
        # standard
        und = cv2.undistortPoints(pts, K, dist, P=K)  # returns pixel coords if P=K
        return und.reshape(-1, 2)


def triangulate_point_multiview(
    Ps: List[np.ndarray],
    pts_px: List[np.ndarray],
) -> np.ndarray:
    """
    Linear multi-view triangulation via DLT:
    For each view i with point (u,v):
      u*P3 - P1 = 0
      v*P3 - P2 = 0
    Stack and solve AX=0 by SVD.
    Returns X (3,)
    """
    A = []
    for P, pt in zip(Ps, pts_px):
        u, v = float(pt[0]), float(pt[1])
        A.append(u * P[2, :] - P[0, :])
        A.append(v * P[2, :] - P[1, :])
    A = np.vstack(A).astype(np.float64)
    _, _, Vt = np.linalg.svd(A)
    X_h = Vt[-1, :]
    if abs(X_h[3]) < 1e-12:
        return np.array([np.nan, np.nan, np.nan], dtype=np.float64)
    X = X_h[:3] / X_h[3]
    return X


def reprojection_errors(Ps: List[np.ndarray], pts_px: List[np.ndarray], X: np.ndarray) -> np.ndarray:
    X_h = np.hstack([X, 1.0]).astype(np.float64)
    errs = []
    for P, pt in zip(Ps, pts_px):
        x = P @ X_h
        if abs(x[2]) < 1e-12:
            errs.append(np.inf)
            continue
        uv = x[:2] / x[2]
        err = float(np.linalg.norm(uv - pt))
        errs.append(err)
    return np.array(errs, dtype=np.float64)


def robust_triangulate_corner(
    observations: List[Tuple[np.ndarray, np.ndarray]],
    reproj_thresh_px: float = 3.0,
    min_views: int = 3,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """
    observations: list of (P, pt_px_ideal) for the SAME corner across frames.
    Returns (X, diag)
    """
    Ps = [o[0] for o in observations]
    pts = [o[1] for o in observations]

    if len(Ps) < 2:
        return np.array([np.nan, np.nan, np.nan], dtype=np.float64), {"ok": False, "reason": "lt2views"}

    keep = np.ones(len(Ps), dtype=bool)

    # iterative outlier removal
    for _ in range(10):
        idx = np.where(keep)[0]
        if idx.size < max(2, min_views):
            break
        Ps_k = [Ps[i] for i in idx]
        pts_k = [pts[i] for i in idx]

        X = triangulate_point_multiview(Ps_k, pts_k)
        if np.any(~np.isfinite(X)):
            return X, {"ok": False, "reason": "nan_triangulation"}

        errs = reprojection_errors(Ps_k, pts_k, X)
        bad = errs > reproj_thresh_px
        if not np.any(bad):
            # converged
            return X, {
                "ok": True,
                "num_views": int(idx.size),
                "median_err_px": float(np.median(errs)),
                "max_err_px": float(np.max(errs)),
            }

        # remove worst offender
        worst_local = int(np.argmax(errs))
        worst_global = int(idx[worst_local])
        keep[worst_global] = False

    # final attempt with what remains
    idx = np.where(keep)[0]
    if idx.size < 2:
        return np.array([np.nan, np.nan, np.nan], dtype=np.float64), {"ok": False, "reason": "all_rejected"}
    Ps_k = [Ps[i] for i in idx]
    pts_k = [pts[i] for i in idx]
    X = triangulate_point_multiview(Ps_k, pts_k)
    errs = reprojection_errors(Ps_k, pts_k, X)
    ok = idx.size >= min_views and float(np.median(errs)) <= reproj_thresh_px
    return X, {
        "ok": bool(ok),
        "num_views": int(idx.size),
        "median_err_px": float(np.median(errs)),
        "max_err_px": float(np.max(errs)),
        "reason": "final",
    }


# -----------------------------
# scene.json scaling (conservative)
# -----------------------------
VECTOR_KEYS = {
    "position", "translation", "center", "centroid", "origin", "min", "max", "p0", "p1", "p2", "p3",
    "camera_center", "camera_position"
}
SCALAR_KEYS = {
    "d", "offset", "distance", "radius", "height", "width", "depth", "size", "length"
}

def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(float(x))

def _is_vec2(x: Any) -> bool:
    return isinstance(x, list) and len(x) == 2 and all(_is_num(v) for v in x)

def _is_vec3(x: Any) -> bool:
    return isinstance(x, list) and len(x) == 3 and all(_is_num(v) for v in x)

def scale_scene_json(obj: Any, s: float, parent_key: Optional[str] = None) -> Any:
    """
    Recursively scale likely-geometric quantities.

    Conservative policy:
      - Scale vec3 only when key context suggests geometry (VECTOR_KEYS)
      - Scale scalar only when key suggests geometry (SCALAR_KEYS)
      - Scale known footprint vec2 geometry:
          * polygon_xz: [[x,z], ...]
          * wall_segments_xz: [[[x,z],[x,z]], ...]
      - Never scale metadata / transforms:
          * scale (dict)
          * alignment (dict)
    """

    # ---- dict ----
    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for k, v in obj.items():
            lk = k.lower()

            # Do not scale metadata/transform blocks
            if lk in {"scale", "alignment"} and isinstance(v, dict):
                out[k] = v
                continue

            # Known vec3 fields
            if _is_vec3(v) and (lk in VECTOR_KEYS or (parent_key and parent_key.lower() in VECTOR_KEYS)):
                out[k] = [float(v[0]) * s, float(v[1]) * s, float(v[2]) * s]
                continue

            # Known scalar fields
            if _is_num(v) and (lk in SCALAR_KEYS):
                out[k] = float(v) * s
                continue

            # Known vec2 footprint polygon
            if lk == "polygon_xz" and isinstance(v, list) and len(v) > 0 and all(_is_vec2(e) for e in v):
                out[k] = [[float(e[0]) * s, float(e[1]) * s] for e in v]
                continue

            # Known vec2 wall segments: [[[x,z],[x,z]], ...]
            if lk == "wall_segments_xz" and isinstance(v, list) and len(v) > 0:
                ok = True
                for seg in v:
                    if not (isinstance(seg, list) and len(seg) == 2 and all(_is_vec2(p) for p in seg)):
                        ok = False
                        break
                if ok:
                    out[k] = [
                        [[float(seg[0][0]) * s, float(seg[0][1]) * s],
                         [float(seg[1][0]) * s, float(seg[1][1]) * s]]
                        for seg in v
                    ]
                    continue

            # Recurse
            out[k] = scale_scene_json(v, s, k)

        return out

    # ---- list ----
    if isinstance(obj, list):
        # list of vec3
        if len(obj) > 0 and all(_is_vec3(e) for e in obj):
            return [[float(e[0]) * s, float(e[1]) * s, float(e[2]) * s] for e in obj]

        # list of vec2 (only safe when the parent key indicates footprint-style data)
        if len(obj) > 0 and all(_is_vec2(e) for e in obj) and parent_key and parent_key.lower() in {"polygon_xz"}:
            return [[float(e[0]) * s, float(e[1]) * s] for e in obj]

        # default recurse
        return [scale_scene_json(e, s, parent_key) for e in obj]

    # ---- primitive ----
    return obj


# -----------------------------
# Main
# -----------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--colmap_text", required=True, help="Path to folder containing cameras.txt, images.txt (COLMAP text output)")
    ap.add_argument("--images_dir", required=True, help="Path to folder containing the frames/images used in COLMAP")
    ap.add_argument("--scene_in", required=True, help="Input scene.json (COLMAP units)")
    ap.add_argument("--scene_out", required=True, help="Output scaled scene.json (meters)")
    ap.add_argument("--aruco_dict", default="DICT_4X4_50", help="ArUco dict name (e.g. DICT_4X4_50)")
    ap.add_argument("--marker_id", type=int, default=0, help="Marker id (use -1 to accept any)")
    ap.add_argument("--marker_size_m", type=float, required=True, help="Marker side length in meters (e.g. 0.10)")
    ap.add_argument("--min_side_px", type=float, default=50.0, help="Minimum marker side length (pixels) to accept detection")
    ap.add_argument("--reproj_thresh_px", type=float, default=3.0, help="Reprojection error threshold (pixels) for outlier rejection")
    ap.add_argument("--min_views", type=int, default=3, help="Minimum views required per corner triangulation")
    ap.add_argument("--write_observations", default="", help="Optional path to save aruco_observations.json")
    ap.add_argument("--diag_out", default="out/step4_diagnostics.json", help="Write step 4 diagnostics JSON")

    # --- Diagnostics thresholds / gates ---
    ap.add_argument("--min_detections", type=int, default=8,
                    help="Minimum number of frames with a valid marker detection (after filtering)")

    ap.add_argument("--max_corner_median_reproj_px", type=float, default=2.0,
                    help="Warn/fail if any corner median reprojection error exceeds this")

    ap.add_argument("--max_corner_max_reproj_px", type=float, default=5.0,
                    help="Warn/fail if any corner max reprojection error exceeds this")

    ap.add_argument("--diag_ratio_tol", type=float, default=0.03,
                    help="Warn/fail if |diag_ratio - 1| exceeds this (square consistency)")

    ap.add_argument("--min_side_px_median", type=float, default=60.0,
                    help="Warn/fail if median detected marker side length in pixels is below this")

    ap.add_argument("--fail_on_warning", action="store_true",
                    help="If set, abort (do not write scaled scene) when diagnostics produce warnings")


    args = ap.parse_args()

    cameras_path = os.path.join(args.colmap_text, "cameras.txt")
    images_path = os.path.join(args.colmap_text, "images.txt")

    for p in (cameras_path, images_path):
        if not os.path.isfile(p):
            raise FileNotFoundError(f"Missing COLMAP text file: {p}")


    cams = load_cameras_txt(cameras_path)
    imgs = load_images_txt(images_path)

    # 1) Detect ArUco corners in images
    obs = detect_aruco_in_images(
        images_dir=args.images_dir,
        colmap_images=imgs,
        aruco_dict_name=args.aruco_dict,
        marker_id=args.marker_id,
        min_side_px=args.min_side_px
    )
    obs["marker_size_m"] = float(args.marker_size_m)

    if args.write_observations:
        os.makedirs(os.path.dirname(args.write_observations), exist_ok=True)
        with open(args.write_observations, "w", encoding="utf-8") as f:
            json.dump(obs, f, indent=2)

    dets = obs["detections"]
    if len(dets) < 2:
        raise RuntimeError(
            f"Too few detections ({len(dets)}) to triangulate. "
            f"Lower --min_side_px or ensure marker appears in more frames."
        )

    side_px_list = [d["side_px"] for d in dets]
    print(f"[Step4] ArUco detections: {len(dets)} frames "
          f"(side_px median={np.median(side_px_list):.1f}, min={np.min(side_px_list):.1f}, max={np.max(side_px_list):.1f})")

    # 2) Build per-corner observations: list of (P, pt_px_ideal)
    corner_obs: List[List[Tuple[np.ndarray, np.ndarray]]] = [[], [], [], []]

    for d in dets:
        image_id = d["image_id"]
        if image_id not in imgs:
            continue
        img = imgs[image_id]
        cam = cams[img.camera_id]

        K, dist = build_intrinsics(cam)
        R = _qvec_to_rotmat(img.qvec)
        t = img.tvec
        P = projection_matrix(K, R, t)

        corners_px = np.array(d["corners_px"], dtype=np.float64).reshape(4, 2)
        # --- FIX: rescale to COLMAP camera resolution if the detection image size differs ---
        w_det, h_det = d.get("image_wh", [cam.width, cam.height])
        if (w_det != cam.width) or (h_det != cam.height):
            sx = cam.width / float(w_det)
            sy = cam.height / float(h_det)
            corners_px[:, 0] *= sx
            corners_px[:, 1] *= sy
            # print only once
            if not hasattr(main, "_printed_rescale"):
                print(f"[Step4] WARNING: detection image size {w_det}x{h_det} != COLMAP {cam.width}x{cam.height}. "
                    f"Rescaling corners by sx={sx:.4f}, sy={sy:.4f}.")
                setattr(main, "_printed_rescale", True)

        corners_px_ideal = undistort_points(corners_px, K, dist, cam.model)

        for ci in range(4):
            corner_obs[ci].append((P, corners_px_ideal[ci]))

    # 3) Robust triangulate each corner
    corners_3d = []
    corner_diags = []
    for ci in range(4):
        X, diag = robust_triangulate_corner(
            corner_obs[ci],
            reproj_thresh_px=args.reproj_thresh_px,
            min_views=args.min_views
        )
        corners_3d.append(X)
        corner_diags.append(diag)

    corners_3d = np.array(corners_3d, dtype=np.float64)  # (4,3)

    if np.any(~np.isfinite(corners_3d)):
        raise RuntimeError(f"Corner triangulation produced NaNs. Diagnostics: {corner_diags}")

    for i, dg in enumerate(corner_diags):
        print(f"[Step4] corner {i}: ok={dg.get('ok')} views={dg.get('num_views')} "
              f"median_err={dg.get('median_err_px', float('nan')):.2f}px max_err={dg.get('max_err_px', float('nan')):.2f}px")

    if not all(dg.get("ok", False) for dg in corner_diags):
        raise RuntimeError(f"One or more corners failed robust triangulation. Diagnostics: {corner_diags}")

    # 4) Compute marker size in COLMAP units using edges (median)
    c = corners_3d
    edges = [
        np.linalg.norm(c[0] - c[1]),
        np.linalg.norm(c[1] - c[2]),
        np.linalg.norm(c[2] - c[3]),
        np.linalg.norm(c[3] - c[0]),
    ]
    measured_edge_colmap = float(np.median(edges))

    # consistency check with diagonals
    diags = [
        np.linalg.norm(c[0] - c[2]),
        np.linalg.norm(c[1] - c[3]),
    ]
    diag_ratio = float(np.median(diags) / (measured_edge_colmap * math.sqrt(2) + 1e-12))

    meters_per_colmap_unit = float(args.marker_size_m / (measured_edge_colmap + 1e-12))

    print(f"[Step4] measured_edge_colmap = {measured_edge_colmap:.6f} (COLMAP units)")
    print(f"[Step4] diagonal consistency ratio (should be ~1.0): {diag_ratio:.4f}")
    print(f"[Step4] meters_per_colmap_unit = {meters_per_colmap_unit:.8f}")


    # -----------------------------
    # Threshold checks -> warnings (and optional fail)
    # -----------------------------
    warnings = []

    num_dets = len(dets)
    side_median = float(np.median(side_px_list))
    side_min = float(np.min(side_px_list))
    side_max = float(np.max(side_px_list))

    if num_dets < args.min_detections:
        warnings.append(f"too_few_detections: {num_dets} < {args.min_detections}")

    if side_median < args.min_side_px_median:
        warnings.append(f"marker_small_in_image: median_side_px {side_median:.1f} < {args.min_side_px_median:.1f} "
                        f"(min={side_min:.1f}, max={side_max:.1f})")

    # Corner reprojection thresholds
    for i, cd in enumerate(corner_diags):
        med = float(cd.get("median_err_px", float("inf")))
        mx = float(cd.get("max_err_px", float("inf")))
        if med > args.max_corner_median_reproj_px:
            warnings.append(f"high_corner_median_reproj: corner={i} median={med:.2f}px > {args.max_corner_median_reproj_px:.2f}px")
        if mx > args.max_corner_max_reproj_px:
            warnings.append(f"high_corner_max_reproj: corner={i} max={mx:.2f}px > {args.max_corner_max_reproj_px:.2f}px")

    # Diagonal consistency
    diag_dev = abs(float(diag_ratio) - 1.0)
    if diag_dev > args.diag_ratio_tol:
        warnings.append(f"diag_ratio_off: diag_ratio={diag_ratio:.4f} dev={diag_dev:.4f} > tol={args.diag_ratio_tol:.4f}")

    status = "ok" if len(warnings) == 0 else "warning"

    if warnings:
        print("[Step4] WARNINGS:")
        for w in warnings:
            print(f"  - {w}")

    if args.fail_on_warning and warnings:
        raise RuntimeError("Step4 diagnostics produced warnings and --fail_on_warning was set. Aborting scaling.")


    # -----------------------------
    # Step 4 diagnostics
    # -----------------------------
    step4_diag = {
        "step": 4,
        "method": "aruco_triangulated_corners_colmap_poses",
        "inputs": {
            "colmap_text": args.colmap_text,
            "images_dir": args.images_dir,
            "scene_in": args.scene_in,
            "scene_out": args.scene_out,
        },
        "aruco": {
            "dict": args.aruco_dict,
            "marker_id": int(obs["marker_id"]),
            "marker_size_m": float(args.marker_size_m),
        },
        "detections": {
            "num_frames_used": int(len(dets)),
            "side_px": {
                "median": float(np.median(side_px_list)),
                "min": float(np.min(side_px_list)),
                "max": float(np.max(side_px_list)),
            },
        },
        "triangulation": {
            "corners_3d_colmap": corners_3d.tolist(),
            "per_corner": [
                {
                    "corner": i,
                    "views": cd.get("num_views"),
                    "median_reproj_px": cd.get("median_err_px"),
                    "max_reproj_px": cd.get("max_err_px"),
                }
                for i, cd in enumerate(corner_diags)
            ],
            "diagonal_consistency_ratio": float(diag_ratio),
        },
        "scale": {
            "measured_edge_colmap": float(measured_edge_colmap),
            "meters_per_colmap_unit": float(meters_per_colmap_unit),
        },
        "thresholds": {
            "min_detections": int(args.min_detections),
            "min_side_px_median": float(args.min_side_px_median),
            "max_corner_median_reproj_px": float(args.max_corner_median_reproj_px),
            "max_corner_max_reproj_px": float(args.max_corner_max_reproj_px),
            "diag_ratio_tol": float(args.diag_ratio_tol),
        },
        "warnings": warnings,
        "status": status,
    }


    # 5) Load scene.json and scale
    with open(args.scene_in, "r", encoding="utf-8") as f:
        scene = json.load(f)

    # Inject scale metadata
    scene_meta = scene.get("scale", {})
    if not isinstance(scene_meta, dict):
        scene_meta = {}

    scene_meta.update({
        "method": "aruco_triangulated_corners_colmap_poses",
        "aruco_dict": args.aruco_dict,
        "marker_id": int(obs["marker_id"]),
        "marker_size_m": float(args.marker_size_m),
        "measured_edge_colmap": measured_edge_colmap,
        "meters_per_colmap_unit": meters_per_colmap_unit,
        "reproj_thresh_px": float(args.reproj_thresh_px),
        "min_views": int(args.min_views),
        "num_detections": int(len(dets)),
        "corner_diags": corner_diags,
        "diag_ratio": diag_ratio,
    })
    
    if "scale" in scene and "meters_per_colmap_unit" in scene["scale"]:
        print("[Step4] WARNING: scene already contains scale metadata.")
        if args.fail_on_warning:
            raise RuntimeError("Scene already appears to be scaled. Aborting.")
        
    scene["scale"] = scene_meta
    scene_scaled = scale_scene_json(scene, meters_per_colmap_unit)

    os.makedirs(os.path.dirname(args.scene_out), exist_ok=True)
    with open(args.scene_out, "w", encoding="utf-8") as f:
        json.dump(scene_scaled, f, indent=2)

    print(f"[Step4] Wrote scaled scene.json -> {args.scene_out}")

    # Write step 4 diagnostics
    os.makedirs(os.path.dirname(args.diag_out), exist_ok=True)
    with open(args.diag_out, "w", encoding="utf-8") as f:
        json.dump(step4_diag, f, indent=2)

    print(f"[Step4] Wrote diagnostics -> {args.diag_out}")



if __name__ == "__main__":
    main()
