#!/usr/bin/env python3
"""
step3_detect_items.py

Detects bathroom items (e.g., toilet, grab_bar) from RGB frames using YOLO,
then localizes them in 3D using COLMAP tracks (points-in-bbox) and writes them
into scene.json after planes.

Key constraints (production):
- Uses Step1 floor_alignment.json to map COLMAP/world points into the aligned scene frame.
- Camera initialization for future ray refinement
  to put objects into the same aligned world frame as scene.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple, Optional

import numpy as np


# ----------------------------
# Load alignment
# ----------------------------

def load_floor_alignment(path: Path) -> Tuple[np.ndarray, np.ndarray]:
    """
    Loads Step1 floor_alignment.json and returns (R, t) where:
    X_aligned = (R @ X_world.T).T + t
    """
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    R = np.array(data["alignment"]["R_world_to_aligned"], dtype=np.float64)
    t = np.array(data["alignment"]["t_world_to_aligned"], dtype=np.float64)
    if R.shape != (3, 3):
        raise ValueError(f"Expected 3x3 rotation in {path}, got {R.shape}")
    if t.shape != (3,):
        raise ValueError(f"Expected 3-vector translation in {path}, got {t.shape}")
    return R, t


def to_aligned_point(p_world: np.ndarray, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    return (R @ p_world.astype(np.float64)) + t


# ----------------------------
# Geometry helpers
# ----------------------------

def normalize(v: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n < eps:
        return v.copy()
    return v / n


def project_point_to_plane(p: np.ndarray, n: np.ndarray, p0: np.ndarray) -> np.ndarray:
    n = normalize(n)
    d = float(np.dot(n, (p - p0)))
    return p - d * n


def robust_centroid(points: np.ndarray) -> np.ndarray:
    """Median centroid; robust to outliers."""
    return np.median(points, axis=0)


def greedy_cluster_centroids(centroids: List[np.ndarray], confs: List[float], dist_thresh: float) -> List[List[int]]:
    """
    Greedy clustering without sklearn.
    Clusters centroids by Euclidean distance <= dist_thresh.
    """
    idxs = list(range(len(centroids)))
    idxs.sort(key=lambda i: confs[i], reverse=True)

    clusters: List[List[int]] = []
    centers: List[np.ndarray] = []

    for i in idxs:
        c = centroids[i]
        assigned = False
        for k, ck in enumerate(centers):
            if float(np.linalg.norm(c - ck)) <= dist_thresh:
                clusters[k].append(i)
                centers[k] = np.mean(np.stack([centroids[j] for j in clusters[k]]), axis=0)
                assigned = True
                break
        if not assigned:
            clusters.append([i])
            centers.append(c.copy())
    return clusters


# ----------------------------
# COLMAP parsing (text)
# ----------------------------

@dataclass
class Camera:
    camera_id: int
    model: str
    width: int
    height: int
    params: np.ndarray


@dataclass
class ImagePose:
    image_id: int
    qvec: np.ndarray  # (4,) qw qx qy qz
    tvec: np.ndarray  # (3,)
    camera_id: int
    name: str
    xys: np.ndarray  # (N,2)
    point3D_ids: np.ndarray  # (N,)


def qvec_to_rotmat(qvec: np.ndarray) -> np.ndarray:
    qw, qx, qy, qz = qvec
    return np.array([
        [1 - 2*qy*qy - 2*qz*qz,     2*qx*qy - 2*qz*qw,     2*qx*qz + 2*qy*qw],
        [2*qx*qy + 2*qz*qw,         1 - 2*qx*qx - 2*qz*qz, 2*qy*qz - 2*qx*qw],
        [2*qx*qz - 2*qy*qw,         2*qy*qz + 2*qx*qw,     1 - 2*qx*qx - 2*qy*qy],
    ], dtype=np.float64)


# currently not used, future ray refinement
def parse_cameras_txt(path: Path) -> Dict[int, Camera]:
    cams: Dict[int, Camera] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        cid = int(parts[0])
        model = parts[1]
        w = int(parts[2])
        h = int(parts[3])
        params = np.array([float(x) for x in parts[4:]], dtype=np.float64)
        cams[cid] = Camera(cid, model, w, h, params)
    return cams


def parse_images_txt(path: Path) -> Dict[int, ImagePose]:
    """
    images.txt blocks:
      IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME
      x y point3D_id x y point3D_id ...
    """
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines()]
    images: Dict[int, ImagePose] = {}
    i = 0
    while i < len(lines):
        ln = lines[i]
        if not ln or ln.startswith("#"):
            i += 1
            continue
        parts = ln.split()
        if len(parts) < 10:
            i += 1
            continue

        image_id = int(parts[0])
        qvec = np.array([float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])], dtype=np.float64)
        tvec = np.array([float(parts[5]), float(parts[6]), float(parts[7])], dtype=np.float64)
        camera_id = int(parts[8])
        name = parts[9]

        i += 1
        pts_line = lines[i] if i < len(lines) else ""
        pts_parts = pts_line.split() if pts_line and not pts_line.startswith("#") else []

        xs, ys, pids = [], [], []
        for k in range(0, len(pts_parts), 3):
            xs.append(float(pts_parts[k + 0]))
            ys.append(float(pts_parts[k + 1]))
            pids.append(int(float(pts_parts[k + 2])))

        xys = np.stack([xs, ys], axis=1) if xs else np.zeros((0, 2), dtype=np.float64)
        point3D_ids = np.array(pids, dtype=np.int64) if pids else np.zeros((0,), dtype=np.int64)

        images[image_id] = ImagePose(image_id, qvec, tvec, camera_id, name, xys, point3D_ids)
        i += 1
    return images


def parse_points3D_txt(path: Path) -> Dict[int, np.ndarray]:
    pts: Dict[int, np.ndarray] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        pid = int(parts[0])
        xyz = np.array([float(parts[1]), float(parts[2]), float(parts[3])], dtype=np.float64)
        pts[pid] = xyz
    return pts


# ----------------------------
# YOLO inference
# ----------------------------

def load_yolo(model_path: Path):
    """
    Prefers ultralytics YOLO; fallback to yolov5 torch.hub (if available locally).
    Returns: infer(img_path: Path, conf: float) -> List[{cls, conf, bbox}]
    """
    try:
        from ultralytics import YOLO  # type: ignore
        model = YOLO(str(model_path))

        def infer(img_path: Path, conf: float):
            res = model.predict(source=str(img_path), conf=conf, verbose=False)
            if not res:
                return []
            r0 = res[0]
            if r0.boxes is None:
                return []
            names = r0.names
            boxes = r0.boxes
            xyxy = boxes.xyxy.cpu().numpy()
            clss = boxes.cls.cpu().numpy().astype(int)
            confs = boxes.conf.cpu().numpy()
            out = []
            for (x1, y1, x2, y2), c, s in zip(xyxy, clss, confs):
                out.append({"cls": str(names[int(c)]), "conf": float(s), "bbox": [float(x1), float(y1), float(x2), float(y2)]})
            return out

        return infer
    except Exception:
        pass

    try:
        import torch  # type: ignore
        model = torch.hub.load("ultralytics/yolov5", "custom", path=str(model_path), force_reload=False)

        def infer(img_path: Path, conf: float):
            model.conf = conf
            res = model(str(img_path))
            df = res.pandas().xyxy[0]
            out = []
            for _, row in df.iterrows():
                out.append({
                    "cls": str(row["name"]),
                    "conf": float(row["confidence"]),
                    "bbox": [float(row["xmin"]), float(row["ymin"]), float(row["xmax"]), float(row["ymax"])],
                })
            return out

        return infer
    except Exception as e:
        raise RuntimeError(
            "Failed to load YOLO. Install `ultralytics` (recommended) or ensure yolov5 hub works.\n"
            f"Underlying error: {e}"
        )


# ----------------------------
# Name matching between frames and COLMAP images.txt
# ----------------------------

def build_image_lookup(img_poses: Dict[int, ImagePose]) -> Tuple[Dict[str, int], Dict[str, int]]:
    """
    Returns:
      - exact_map: pose.name -> image_id (as in images.txt)
      - base_map: basename(pose.name) -> image_id (fallback for path differences)
    """
    exact = {}
    base = {}
    for pose in img_poses.values():
        exact[pose.name] = pose.image_id
        base[Path(pose.name).name] = pose.image_id
    return exact, base

# ----------------------------
# create obj file to see in meshlab
# ----------------------------

def write_bboxes_obj(objects: List[dict], out_path: Path) -> None:
    """
    Writes an OBJ containing axis-aligned boxes from each object's bbox_aligned.
    MeshLab can load this to visualize detection volumes.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: List[str] = []
    lines.append("# Object bounding boxes")
    lines.append("# Each group 'g <id>' corresponds to one object bbox_aligned")

    v_offset = 1  # OBJ is 1-indexed

    for obj in objects:
        oid = obj.get("id", "obj")
        bb = obj.get("bbox_aligned", {})
        mn = np.array(bb.get("min", [0, 0, 0]), dtype=np.float64)
        mx = np.array(bb.get("max", [0, 0, 0]), dtype=np.float64)

        # 8 corners
        x0, y0, z0 = mn.tolist()
        x1, y1, z1 = mx.tolist()
        corners = [
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ]

        lines.append(f"g {oid}")
        for (x, y, z) in corners:
            lines.append(f"v {x:.6f} {y:.6f} {z:.6f}")

        # Faces (12 triangles) so it renders solid
        # bottom (0,1,2,3), top (4,5,6,7), sides
        f = [
            (0, 1, 2), (0, 2, 3),  # bottom
            (4, 6, 5), (4, 7, 6),  # top
            (0, 4, 5), (0, 5, 1),  # side
            (1, 5, 6), (1, 6, 2),  # side
            (2, 6, 7), (2, 7, 3),  # side
            (3, 7, 4), (3, 4, 0),  # side
        ]
        for (a, b, c) in f:
            lines.append(f"f {v_offset + a} {v_offset + b} {v_offset + c}")

        v_offset += 8

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ----------------------------
# Main
# ----------------------------

@dataclass
class DetCand:
    cls: str
    conf: float
    image_name: str
    bbox: List[float]
    pts: np.ndarray
    centroid: np.ndarray


def main():
    ap = argparse.ArgumentParser()

    # required production args (no directory assumptions)
    ap.add_argument("--images_dir", required=True, help="Directory of RGB frames used for YOLO (e.g., projects/seb1/seb1_images)")
    ap.add_argument("--colmap_text_dir", required=True, help="Directory containing COLMAP text model (cameras.txt, images.txt, points3D.txt)")
    ap.add_argument("--scene_json", required=True, help="Path to scene.json produced by step2 (will be updated with objects)")
    ap.add_argument("--floor_alignment_json", required=True, help="Path to Step1 floor_alignment.json")
    ap.add_argument("--model", required=True, help="Path to YOLO weights (.pt)")

    # optional behaviour/tuning
    ap.add_argument("--conf", type=float, default=0.35, help="YOLO confidence threshold")
    ap.add_argument("--classes", type=str, default="toilet,grab_bar", help="Comma-separated classes to keep")
    ap.add_argument("--max_images", type=int, default=0, help="If >0, only run YOLO on first N images (debug)")
    ap.add_argument("--min_points_toilet", type=int, default=30, help="Min COLMAP 3D points to accept a toilet detection")
    ap.add_argument("--min_points_grab", type=int, default=12, help="Min COLMAP 3D points to accept a grab bar detection")
    ap.add_argument("--cluster_dist_toilet", type=float, default=3.0, help="Clustering distance (aligned units) for toilet instances")
    ap.add_argument("--cluster_dist_grab", type=float, default=0.75, help="Clustering distance (aligned units) for grab bar instances")
    ap.add_argument("--wall_dist_thresh", type=float, default=0.07, help="Keep grab bar points within this dist to some wall plane")
    ap.add_argument("--write_backup", action="store_true", help="Write scene.json.bak before overwriting")
    ap.add_argument("--diagnostics_json", type=str, default=None, help="Optional path to write step3 diagnostics JSON")

    # test args
    ap.add_argument("--min_detections_toilet", type=int, default=2,
                help="Minimum number of 2D detections contributing to a toilet instance")
    ap.add_argument("--max_toilets", type=int, default=1,
                    help="Keep at most this many toilet instances (highest evidence). Use 0 for unlimited.")
    ap.add_argument("--toilet_max_base_y", type=float, default=0.35,
                    help="Reject toilet instances whose 5th percentile of point Y is above this (aligned units)")
    ap.add_argument("--toilet_max_p95_y", type=float, default=6.0,
                    help="Reject toilet instances whose 95th percentile of point Y is above this (aligned units)")

    ap.add_argument("--bboxes_obj", default=None,
                    help="Optional output path for an OBJ containing all object bbox_aligned boxes (for MeshLab)")


    args = ap.parse_args()

    images_dir = Path(args.images_dir).resolve()
    colmap_text_dir = Path(args.colmap_text_dir).resolve()
    scene_json_path = Path(args.scene_json).resolve()
    floor_alignment_json = Path(args.floor_alignment_json).resolve()
    model_path = Path(args.model).resolve()

    # Validate inputs
    if not images_dir.is_dir():
        raise NotADirectoryError(images_dir)
    if not colmap_text_dir.is_dir():
        raise NotADirectoryError(colmap_text_dir)
    if not scene_json_path.exists():
        raise FileNotFoundError(scene_json_path)
    if not floor_alignment_json.exists():
        raise FileNotFoundError(floor_alignment_json)
    if not model_path.exists():
        raise FileNotFoundError(model_path)

    cameras_path = colmap_text_dir / "cameras.txt"
    images_path = colmap_text_dir / "images.txt"
    points_path = colmap_text_dir / "points3D.txt"
    for p in (cameras_path, images_path, points_path):
        if not p.exists():
            raise FileNotFoundError(f"Missing COLMAP file: {p}")

    # Load transforms from step1 output
    R_align, t_align = load_floor_alignment(floor_alignment_json)
    print(f"[step3] Loaded floor alignment from {floor_alignment_json.name}", flush=True)

    # Load scene (planes were produced by step2 in aligned frame)
    scene = json.loads(scene_json_path.read_text(encoding="utf-8"))
    planes = scene.get("planes", [])
    floor = next((p for p in planes if p.get("id") == "floor"), None)
    if floor is None:
        raise RuntimeError("scene.json missing plane id='floor'")

    wall_planes = [p for p in planes if p.get("type") == "wall"]
    print(f"[step3] Scene planes loaded: {len(planes)} total, {len(wall_planes)} wall(s)", flush=True)

    floor_n = np.array(floor["normal"], dtype=np.float64)
    floor_p0 = np.array(floor["point"], dtype=np.float64)

    wall_normals = [np.array(p["normal"], dtype=np.float64) for p in wall_planes]
    wall_points = [np.array(p["point"], dtype=np.float64) for p in wall_planes]
    wall_normals_u = [normalize(n) for n in wall_normals]

    # Load COLMAP model
    cams = parse_cameras_txt(cameras_path)
    img_poses = parse_images_txt(images_path)
    pts3d = parse_points3D_txt(points_path)
    exact_map, base_map = build_image_lookup(img_poses)
    print(
        f"[step3] COLMAP model loaded: {len(cams)} camera(s), "
        f"{len(img_poses)} image pose(s), {len(pts3d)} 3D points",
        flush=True,
    )

    # YOLO
    print(f"[step3] Loading YOLO model: {model_path.name}", flush=True)
    infer = load_yolo(model_path)
    print(f"[step3] YOLO model loaded", flush=True)

    keep_classes = {c.strip() for c in args.classes.split(",") if c.strip()}
    print(f"[step3] Detection classes: {sorted(keep_classes)}  conf_threshold={args.conf}", flush=True)
    class_alias = {
        "grab bar": "grab_bar",
        "grabbar": "grab_bar",
        "grab_bar": "grab_bar",
        "toilet": "toilet",
    }

    # Collect image list
    image_files = sorted([p for p in images_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")])
    if args.max_images > 0:
        image_files = image_files[: args.max_images]
    print(f"[step3] Running YOLO on {len(image_files)} frames ...", flush=True)

    # Run detections
    detections_by_image: Dict[str, List[dict]] = {}
    det_counts: Dict[str, int] = {}
    log_every = max(1, len(image_files) // 10)

    for idx, img_path in enumerate(image_files):
        dets = infer(img_path, args.conf)
        cleaned = []
        for d in dets:
            cls_raw = str(d["cls"]).strip().lower()
            cls = class_alias.get(cls_raw, cls_raw)
            if cls in keep_classes:
                cleaned.append({"cls": cls, "conf": float(d["conf"]), "bbox": d["bbox"]})
                det_counts[cls] = det_counts.get(cls, 0) + 1
        if cleaned:
            detections_by_image[img_path.name] = cleaned
            det_summary = ", ".join(
                f"{d['cls']}({d['conf']:.2f})" for d in cleaned
            )
            print(f"[step3]   {img_path.name}: {det_summary}", flush=True)
        elif (idx + 1) % log_every == 0:
            print(f"[step3]   Progress: {idx + 1}/{len(image_files)} frames scanned ...", flush=True)

    print(
        f"[step3] YOLO done: {len(detections_by_image)}/{len(image_files)} frames had detections  "
        + "  ".join(f"{cls}={n}" for cls, n in sorted(det_counts.items())),
        flush=True,
    )

    if not detections_by_image:
        print("[step3] No detections after filtering.", file=sys.stderr, flush=True)
        return 0

    # Helper: find COLMAP image_id given a frame filename
    def resolve_image_id(frame_name: str) -> Optional[int]:
        if frame_name in exact_map:
            return exact_map[frame_name]
        if frame_name in base_map:
            return base_map[frame_name]
        return None

    # Helper: extract aligned-frame 3D points whose 2D projections fall inside bbox
    def points_in_bbox(frame_name: str, bbox: List[float]) -> np.ndarray:
        image_id = resolve_image_id(frame_name)
        if image_id is None:
            return np.zeros((0, 3), dtype=np.float64)

        pose = img_poses[image_id]
        if pose.xys.shape[0] == 0:
            return np.zeros((0, 3), dtype=np.float64)

        x1, y1, x2, y2 = bbox
        xy = pose.xys
        pid = pose.point3D_ids

        inside = (xy[:, 0] >= x1) & (xy[:, 0] <= x2) & (xy[:, 1] >= y1) & (xy[:, 1] <= y2) & (pid >= 0)
        pids = np.unique(pid[inside])

        pts_aligned = []
        for u in pids.tolist():
            u = int(u)
            if u in pts3d:
                P = pts3d[u]                      # world/COLMAP
                Pa = to_aligned_point(P, R_align, t_align)   # aligned
                pts_aligned.append(Pa)
        if not pts_aligned:
            return np.zeros((0, 3), dtype=np.float64)

        return np.stack(pts_aligned, axis=0)

    # Build candidates
    print("[step3] Building 3D candidates from COLMAP tracks ...", flush=True)
    candidates: List[DetCand] = []
    dropped_no_colmap = 0
    dropped_low_support = 0
    dropped_wall_filter = 0

    for frame_name, dets in detections_by_image.items():
        if resolve_image_id(frame_name) is None:
            dropped_no_colmap += len(dets)
            print(f"[step3]   DROP no-colmap-match: {frame_name} ({len(dets)} det(s))", flush=True)
            continue

        for d in dets:
            cls = d["cls"]
            bbox = d["bbox"]
            conf = float(d["conf"])

            pts = points_in_bbox(frame_name, bbox)
            min_pts = args.min_points_toilet if cls == "toilet" else args.min_points_grab

            if cls == "toilet" and pts.shape[0] < args.min_points_toilet:
                print(
                    f"[step3]   DROP low-3d-support: {frame_name} {cls}({conf:.2f}) "
                    f"got {pts.shape[0]}<{args.min_points_toilet} pts",
                    flush=True,
                )
                dropped_low_support += 1
                continue
            if cls == "grab_bar" and pts.shape[0] < args.min_points_grab:
                print(
                    f"[step3]   DROP low-3d-support: {frame_name} {cls}({conf:.2f}) "
                    f"got {pts.shape[0]}<{args.min_points_grab} pts",
                    flush=True,
                )
                dropped_low_support += 1
                continue

            # Grab bar: filter points close to ANY wall plane (reduces wall/background bleed)
            if cls == "grab_bar" and wall_planes:
                keep = np.zeros((pts.shape[0],), dtype=bool)
                for wn_u, wp in zip(wall_normals_u, wall_points):
                    dists = np.abs((pts - wp) @ wn_u)
                    keep |= (dists <= args.wall_dist_thresh)
                pts_before = pts.shape[0]
                pts = pts[keep]
                if pts.shape[0] < args.min_points_grab:
                    print(
                        f"[step3]   DROP wall-filter: {frame_name} {cls}({conf:.2f}) "
                        f"{pts_before} pts -> {pts.shape[0]} near-wall (need {args.min_points_grab})",
                        flush=True,
                    )
                    dropped_wall_filter += 1
                    dropped_low_support += 1
                    continue

            c = robust_centroid(pts)
            candidates.append(DetCand(cls=cls, conf=conf, image_name=frame_name, bbox=bbox, pts=pts, centroid=c))
            print(
                f"[step3]   ACCEPT: {frame_name} {cls}({conf:.2f}) "
                f"{pts.shape[0]} pts  centroid=({c[0]:.3f}, {c[1]:.3f}, {c[2]:.3f})",
                flush=True,
            )

    print(
        f"[step3] Candidates: {len(candidates)} accepted  "
        f"dropped: {dropped_no_colmap} no-colmap  "
        f"{dropped_low_support} low-support ({dropped_wall_filter} wall-filtered)",
        flush=True,
    )

    if not candidates:
        print("[step3] All detections were filtered out (no 3D support).", file=sys.stderr, flush=True)
        return 0

    # Cluster into object instances per class
    objects_out: List[dict] = []
    next_id = 1

    def add_instance(cls: str, idxs: List[int]):
        nonlocal next_id
        mem = [candidates[i] for i in idxs]
        all_pts = np.concatenate([m.pts for m in mem], axis=0)
        pos = robust_centroid(all_pts)
        conf_avg = float(np.mean([m.conf for m in mem]))
        img_names = sorted(list({m.image_name for m in mem}))
        instance_label = f"{cls}_{next_id}"

        # Multi-view requirement for toilets
        if cls == "toilet" and len(mem) < args.min_detections_toilet:
            print(
                f"[step3]   REJECT {instance_label}: only {len(mem)} detection(s) "
                f"(need {args.min_detections_toilet})",
                flush=True,
            )
            return

        # Geometry plausibility checks (toilet should be floor-adjacent in Y)
        if cls == "toilet":
            y_vals = all_pts[:, 1]
            p05 = float(np.quantile(y_vals, 0.05))
            p95 = float(np.quantile(y_vals, 0.95))
            if p05 > args.toilet_max_base_y:
                print(
                    f"[step3]   REJECT {instance_label}: p05_y={p05:.3f} > max_base_y={args.toilet_max_base_y}",
                    flush=True,
                )
                return
            if p95 > args.toilet_max_p95_y:
                print(
                    f"[step3]   REJECT {instance_label}: p95_y={p95:.3f} > max_p95_y={args.toilet_max_p95_y}",
                    flush=True,
                )
                return

        # Snap to planes (scene is already aligned frame from step2)
        support_plane = None
        if cls == "toilet":
            pos = project_point_to_plane(pos, floor_n, floor_p0)
            support_plane = "floor"
        elif cls == "grab_bar" and wall_planes:
            best_w = None
            best_med = float("inf")
            for wi, (wn_u, wp) in enumerate(zip(wall_normals_u, wall_points)):
                dists = np.abs((all_pts - wp) @ wn_u)
                med = float(np.median(dists)) if dists.size else float("inf")
                if med < best_med:
                    best_med = med
                    best_w = wi
            if best_w is not None:
                pos = project_point_to_plane(pos, wall_normals_u[best_w], wall_points[best_w])
                support_plane = wall_planes[best_w]["id"]

        mn = np.min(all_pts, axis=0).tolist()
        mx = np.max(all_pts, axis=0).tolist()

        print(
            f"[step3]   ADD {instance_label}: conf={conf_avg:.2f}  "
            f"pts={all_pts.shape[0]}  dets={len(mem)}  support={support_plane}  "
            f"pos=({pos[0]:.3f}, {pos[1]:.3f}, {pos[2]:.3f})  "
            f"frames={img_names[:5]}{'...' if len(img_names) > 5 else ''}",
            flush=True,
        )

        objects_out.append({
            "id": instance_label,
            "type": cls,
            "confidence": conf_avg,
            "position": pos.tolist(),
            "bbox_aligned": {"min": mn, "max": mx},
            "support_plane": support_plane,
            "evidence": {
                "num_points": int(all_pts.shape[0]),
                "num_detections": int(len(mem)),
                "image_names": img_names[:50],
            },
        })
        next_id += 1

    print("[step3] Clustering candidates into object instances ...", flush=True)
    for cls in sorted(keep_classes):
        cls_idxs = [i for i, c in enumerate(candidates) if c.cls == cls]
        if not cls_idxs:
            print(f"[step3]   {cls}: 0 candidates, skipping", flush=True)
            continue

        dist_thresh = args.cluster_dist_toilet if cls == "toilet" else args.cluster_dist_grab
        centroids = [candidates[i].centroid for i in cls_idxs]
        confs = [candidates[i].conf for i in cls_idxs]

        clusters_local = greedy_cluster_centroids(centroids, confs, dist_thresh)
        print(
            f"[step3]   {cls}: {len(cls_idxs)} candidate(s) -> "
            f"{len(clusters_local)} cluster(s)  dist_thresh={dist_thresh}",
            flush=True,
        )
        for cl in clusters_local:
            member_global = [cls_idxs[j] for j in cl]
            add_instance(cls, member_global)

    if args.max_toilets and args.max_toilets > 0:
        toilets = [o for o in objects_out if o["type"] == "toilet"]
        others = [o for o in objects_out if o["type"] != "toilet"]
        toilets.sort(key=lambda o: (o.get("evidence", {}).get("num_detections", 0),
                                    o.get("evidence", {}).get("num_points", 0),
                                    o.get("confidence", 0.0)), reverse=True)
        if len(toilets) > args.max_toilets:
            print(
                f"[step3] Capping toilets: keeping top {args.max_toilets}/{len(toilets)} by evidence",
                flush=True,
            )
        objects_out = toilets[:args.max_toilets] + others

    by_class = {}
    for o in objects_out:
        by_class[o["type"]] = by_class.get(o["type"], 0) + 1
    print(
        f"[step3] Final objects: {len(objects_out)}  "
        + "  ".join(f"{cls}={n}" for cls, n in sorted(by_class.items())),
        flush=True,
    )

    # Write updated scene.json
    if args.write_backup:
        backup_path = scene_json_path.with_name(scene_json_path.name + ".bak")
        if not backup_path.exists():
            backup_path.write_text(scene_json_path.read_text(encoding="utf-8"), encoding="utf-8")

    scene["objects"] = objects_out

    scene.setdefault("objects_meta", {})
    scene["objects_meta"]["source"] = "step3_detect_items"
    scene["objects_meta"]["floor_alignment_json"] = str(floor_alignment_json.name)

    scene_json_path.write_text(json.dumps(scene, indent=2), encoding="utf-8")

    # Optional: write bbox OBJ for MeshLab visualization
    if args.bboxes_obj:
        obj_path = Path(args.bboxes_obj).resolve()
        write_bboxes_obj(objects_out, obj_path)
        print(f"[step3] Wrote bbox OBJ to {obj_path}")

    # Optional diagnostics
    if args.diagnostics_json:
        diag_path = Path(args.diagnostics_json).resolve()
        diag = {
            "phase": "step3_detect_items",
            "inputs": {
                "images_dir": str(images_dir),
                "colmap_text_dir": str(colmap_text_dir),
                "scene_json": str(scene_json_path),
                "floor_alignment_json": str(floor_alignment_json),
                "frame": "aligned_world",
                "model": str(model_path),
            },
            "params": {
                "conf": args.conf,
                "classes": sorted(list(keep_classes)),
                "min_points_toilet": args.min_points_toilet,
                "min_points_grab": args.min_points_grab,
                "cluster_dist_toilet": args.cluster_dist_toilet,
                "cluster_dist_grab": args.cluster_dist_grab,
                "wall_dist_thresh": args.wall_dist_thresh,
            },
            "counts": {
                "images_total": int(len(image_files)),
                "images_with_detections": int(len(detections_by_image)),
                "candidates": int(len(candidates)),
                "objects_by_class": {
                    "toilet": sum(1 for o in objects_out if o["type"] == "toilet"),
                    "grab_bar": sum(1 for o in objects_out if o["type"] == "grab_bar"),
                },
                "dropped_no_colmap_match": int(dropped_no_colmap),
                "dropped_low_3d_support": int(dropped_low_support),
            },
        }
        diag_path.write_text(json.dumps(diag, indent=2), encoding="utf-8")

    print(f"[step3] Wrote {len(objects_out)} objects into {scene_json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
