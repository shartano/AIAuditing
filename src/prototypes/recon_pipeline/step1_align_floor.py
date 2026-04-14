import argparse
import os

import json
import math
from dataclasses import dataclass
from typing import Dict, Tuple, Optional, List

import numpy as np


# -------------------------
# COLMAP I/O
# -------------------------

def load_points3d_txt(path: str, error_max: float) -> np.ndarray:
    """
    Returns Nx3 array of filtered 3D points from COLMAP points3D.txt.
    Filters by reprojection ERROR <= error_max.
    """
    xs = []
    errs = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            # ID X Y Z R G B ERROR TRACK[]
            x, y, z = map(float, parts[1:4])
            err = float(parts[7])
            xs.append((x, y, z))
            errs.append(err)
    X = np.array(xs, dtype=np.float64)
    E = np.array(errs, dtype=np.float64)
    return X[E <= error_max]


def qvec2rotmat(qvec: np.ndarray) -> np.ndarray:
    """
    COLMAP quaternion (qw,qx,qy,qz) to rotation matrix.
    """
    w, x, y, z = qvec
    return np.array([
        [1 - 2*y*y - 2*z*z, 2*x*y - 2*w*z,     2*x*z + 2*w*y],
        [2*x*y + 2*w*z,     1 - 2*x*x - 2*z*z, 2*y*z - 2*w*x],
        [2*x*z - 2*w*y,     2*y*z + 2*w*x,     1 - 2*x*x - 2*y*y]
    ], dtype=np.float64)


def load_camera_centers_images_txt(images_txt: str) -> np.ndarray:
    """
    Reads COLMAP images.txt and returns Mx3 camera centers.
    Camera center C = -R^T t.
    """
    centers = []
    with open(images_txt, "r", encoding="utf-8") as f:
        lines = f.readlines()

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line.startswith("#"):
            i += 1
            continue

        parts = line.split()
        # IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME
        if len(parts) < 10:
            i += 1
            continue

        qw, qx, qy, qz = map(float, parts[1:5])
        tx, ty, tz = map(float, parts[5:8])

        R = qvec2rotmat(np.array([qw, qx, qy, qz], dtype=np.float64))
        t = np.array([tx, ty, tz], dtype=np.float64)
        C = -R.T @ t
        centers.append(C)

        # Skip next line: 2D points
        i += 2

    if not centers:
        raise RuntimeError("No camera centers found in images.txt (unexpected format or empty file).")
    return np.array(centers, dtype=np.float64)


# -------------------------
# Geometry helpers
# -------------------------

def bbox_extent(X: np.ndarray) -> Tuple[np.ndarray, np.ndarray, float]:
    mins = X.min(axis=0)
    maxs = X.max(axis=0)
    extent = float(np.linalg.norm(maxs - mins))
    return mins, maxs, extent


def plane_from_3pts(p1: np.ndarray, p2: np.ndarray, p3: np.ndarray) -> Optional[Tuple[np.ndarray, float]]:
    v1 = p2 - p1
    v2 = p3 - p1
    n = np.cross(v1, v2)
    norm = np.linalg.norm(n)
    if norm < 1e-12:
        return None
    n = n / norm
    d = -float(np.dot(n, p1))
    return n, d


def plane_inliers(X: np.ndarray, n: np.ndarray, d: float, thr: float) -> Tuple[np.ndarray, np.ndarray]:
    dist = np.abs(X @ n + d)
    mask = dist < thr
    return mask, dist


def refine_plane_svd(P: np.ndarray) -> Tuple[np.ndarray, float, np.ndarray]:
    """
    Fit plane to inlier points by SVD:
    normal = last right-singular vector of centered points.
    Returns (n, d, centroid)
    """
    centroid = P.mean(axis=0)
    Q = P - centroid
    _, _, vh = np.linalg.svd(Q, full_matrices=False)
    n = vh[-1]
    n = n / np.linalg.norm(n)
    d = -float(np.dot(n, centroid))
    return n, d, centroid


def rodrigues(axis: np.ndarray, angle: float) -> np.ndarray:
    axis = axis / np.linalg.norm(axis)
    K = np.array([
        [0, -axis[2], axis[1]],
        [axis[2], 0, -axis[0]],
        [-axis[1], axis[0], 0]
    ], dtype=np.float64)
    I = np.eye(3, dtype=np.float64)
    return I + math.sin(angle) * K + (1 - math.cos(angle)) * (K @ K)


def make_rotation_align(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """
    Returns R such that R @ a == b (for unit vectors a,b), using a stable formulation.
    """
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    s = np.linalg.norm(v)
    c = float(np.dot(a, b))

    if s < 1e-12:
        if c > 0:
            return np.eye(3, dtype=np.float64)
        # 180 degree flip
        tmp = np.array([1.0, 0.0, 0.0], dtype=np.float64)
        if abs(np.dot(tmp, a)) > 0.9:
            tmp = np.array([0.0, 0.0, 1.0], dtype=np.float64)
        axis = np.cross(a, tmp)
        axis /= np.linalg.norm(axis)
        return rodrigues(axis, math.pi)

    axis = v / s
    angle = math.atan2(s, c)
    return rodrigues(axis, angle)


# -------------------------
# RANSAC plane extraction
# -------------------------

@dataclass
class PlaneCandidate:
    n: np.ndarray         # unit normal
    d: float
    inliers: int
    med_inlier_dist: float
    centroid: np.ndarray


def ransac_best_plane(X: np.ndarray, thr: float, iters: int, rng: np.random.Generator) -> Optional[Tuple[np.ndarray, float, np.ndarray, np.ndarray]]:
    """
    Returns (n, d, inlier_mask, dist) for best plane found by RANSAC, refined via SVD.
    """
    N = len(X)
    if N < 3:
        return None

    best_n = None
    best_d = None
    best_mask = None
    best_count = 0

    for _ in range(iters):
        idx = rng.choice(N, size=3, replace=False)
        p1, p2, p3 = X[idx]
        model = plane_from_3pts(p1, p2, p3)
        if model is None:
            continue
        n, d = model
        mask, _ = plane_inliers(X, n, d, thr)
        count = int(mask.sum())
        if count > best_count:
            best_count = count
            best_n, best_d, best_mask = n, d, mask

    if best_n is None:
        return None

    P = X[best_mask]
    n_ref, d_ref, _ = refine_plane_svd(P)
    mask_ref, dist_ref = plane_inliers(X, n_ref, d_ref, thr)
    return n_ref, d_ref, mask_ref, dist_ref


def extract_top_planes(X: np.ndarray,
                       thr: float,
                       iters: int,
                       top_k: int,
                       min_inliers: int,
                       rng_seed: int = 42) -> List[PlaneCandidate]:
    """
    Iteratively extracts up to top_k dominant planes by RANSAC "peeling".
    """
    rng = np.random.default_rng(rng_seed)
    X_work = X.copy()
    planes: List[PlaneCandidate] = []

    for _ in range(top_k):
        res = ransac_best_plane(X_work, thr, iters, rng)
        if res is None:
            break
        n, d, mask, dist = res
        count = int(mask.sum())
        if count < min_inliers:
            break

        P = X_work[mask]
        centroid = P.mean(axis=0)
        med_dist = float(np.median(dist[mask]))

        planes.append(PlaneCandidate(n=n, d=float(d), inliers=count, med_inlier_dist=med_dist, centroid=centroid))

        # Peel inliers
        X_work = X_work[~mask]
        if len(X_work) < min_inliers:
            break

    return planes


# -------------------------
# Floor selection + alignment
# -------------------------

@dataclass
class AlignmentResult:
    score: float
    frac_cams_above: float
    frac_points_below: float
    p01_y: float
    p05_y: float
    inliers: int
    med_inlier_dist: float
    rotated_normal: np.ndarray
    R: np.ndarray
    y_shift: float
    plane: PlaneCandidate
    plane_index: int = -1
    sign: int = 0



def score_plane_as_floor(X: np.ndarray,
                         Cams: np.ndarray,
                         plane: PlaneCandidate,
                         sign: int,
                         thr: float,
                         eps: float) -> Optional[AlignmentResult]:
    """
    Try a plane as the floor with normal sign (+1 or -1), align it to +Y,
    translate so median floor inlier y = 0, and score the result.
    """
    n = (sign * plane.n).copy()
    n = n / np.linalg.norm(n)
    d = sign * plane.d

    # Inliers in original coordinates (for translation anchor later)
    inlier_mask, dist = plane_inliers(X, n, d, thr)
    count = int(inlier_mask.sum())
    if count < max(100, int(0.002 * len(X))):
        return None

    up = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    R = make_rotation_align(n, up)

    Xr = (R @ X.T).T
    Cr = (R @ Cams.T).T

    # translate so plane inliers median y = 0
    y0 = float(np.median(Xr[inlier_mask][:, 1]))
    Xt = Xr.copy()
    Ct = Cr.copy()
    Xt[:, 1] -= y0
    Ct[:, 1] -= y0

    frac_cams_above = float(np.mean(Ct[:, 1] > eps))
    frac_points_below = float(np.mean(Xt[:, 1] < -eps))
    p01_y = float(np.quantile(Xt[:, 1], 0.01))
    p05_y = float(np.quantile(Xt[:, 1], 0.05))
    med_inlier_dist = float(np.median(dist[inlier_mask]))
    n_rot = R @ n

    # Scoring: prefer true floor (few points below), correct up (cams above), support (inliers)
    # You can tune weights later; these are conservative.
    score = (3.0 * (1.0 - frac_points_below)
             + 2.0 * frac_cams_above
             + 0.5 * (count / 10000.0))

    return AlignmentResult(
        score=score,
        frac_cams_above=frac_cams_above,
        frac_points_below=frac_points_below,
        p01_y=p01_y,
        p05_y=p05_y,
        inliers=count,
        med_inlier_dist=med_inlier_dist,
        rotated_normal=n_rot,
        R=R,
        y_shift=y0,
        plane=plane,
        sign=sign
    )


def choose_best_floor_alignment(X: np.ndarray,
                               Cams: np.ndarray,
                               planes: List[PlaneCandidate],
                               thr: float,
                               eps: float) -> AlignmentResult:
    """
    Evaluate extracted planes as possible floors (horizontal-ish), try both normal signs,
    and return the best scoring alignment.
    """

    best: Optional[AlignmentResult] = None
    best_plane_idx: Optional[int] = None

    for i, plane in enumerate(planes):
        for sign in (+1, -1):
            res = score_plane_as_floor(X, Cams, plane, sign, thr, eps)
            if res is None:
                continue
            if best is None or res.score > best.score:
                best = res
                best_plane_idx = i


    if best is None or best_plane_idx is None:
        raise RuntimeError("Failed to select a best floor plane (unexpected).")
    
    best.plane_index = int(best_plane_idx)
    return best


def apply_alignment(X: np.ndarray, R: np.ndarray, y_shift: float) -> np.ndarray:
    Xr = (R @ X.T).T
    Xr[:, 1] -= y_shift
    return Xr


# -------------------------
# Main
# -------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--points", required=True, help="Path to COLMAP points3D.txt")
    ap.add_argument("--images", required=True, help="Path to COLMAP images.txt")
    ap.add_argument("--error_max", type=float, default=4.0, help="Max reprojection error to keep a 3D point")
    ap.add_argument("--top_k", type=int, default=10, help="Number of dominant planes to extract")
    ap.add_argument("--ransac_iters", type=int, default=4000, help="RANSAC iterations per plane")
    ap.add_argument("--thr_ratio", type=float, default=0.0035,
                    help="RANSAC inlier threshold as a fraction of scene extent (diag). Typical 0.002–0.006")
    ap.add_argument("--min_inliers_ratio", type=float, default=0.01,
                    help="Minimum inliers per plane as fraction of filtered points. Typical 0.005–0.02")
    ap.add_argument("--eps_ratio", type=float, default=0.0005,
                    help="Epsilon (for above/below tests) as a fraction of scene extent. Typical 0.0003–0.001")
    ap.add_argument("--out_dir", default="out", help="Output directory for Phase 1 results")
    ap.add_argument("--out_xyz", default="points3D_aligned.xyz", help="Name of aligned XYZ file")

    ap.add_argument("--seed", type=int, default=42, help="RNG seed for RANSAC")

    args = ap.parse_args()
 
    os.makedirs(args.out_dir, exist_ok=True)

    X = load_points3d_txt(args.points, args.error_max)
    Cams = load_camera_centers_images_txt(args.images)

    if len(X) < 2000:
        raise RuntimeError(f"Too few filtered points ({len(X)}). Consider raising --error_max or using more images.")

    mins, maxs, extent = bbox_extent(X)
    thr = max(1e-6, args.thr_ratio * extent)
    eps = max(1e-6, args.eps_ratio * extent)
    min_inliers = max(200, int(args.min_inliers_ratio * len(X)))

    print("Filtered points:", len(X))
    print("Camera centers:", len(Cams))
    print("BBox min:", mins)
    print("BBox max:", maxs)
    print("Extent (diag):", extent)
    print("RANSAC thr:", thr, "eps:", eps, "min_inliers:", min_inliers)

    planes = extract_top_planes(
        X=X,
        thr=thr,
        iters=args.ransac_iters,
        top_k=args.top_k,
        min_inliers=min_inliers,
        rng_seed=args.seed
    )

    if not planes:
        raise RuntimeError("No planes extracted. Try increasing --thr_ratio or --ransac_iters.")

    print("\nExtracted planes:")
    for i, p in enumerate(planes, 1):
        print(f"  Plane {i}: inliers={p.inliers} med_dist={p.med_inlier_dist:.6f} n={p.n} d={p.d:.6f}")

    best = choose_best_floor_alignment(
        X=X,
        Cams=Cams,
        planes=planes,
        thr=thr,
        eps=eps,
    )

    print("\n=== BEST FLOOR ===")
    print("sign:", best.sign)
    print("inliers:", best.inliers, "med_inlier_dist:", best.med_inlier_dist)
    print("frac_cams_above:", best.frac_cams_above)
    print("frac_points_below:", best.frac_points_below)
    print("p01_y:", best.p01_y, "p05_y:", best.p05_y)
    print("rotated_normal:", best.rotated_normal)
    print("y_shift:", best.y_shift)

    ALIGN_PATH = os.path.join(args.out_dir, "floor_alignment.json")
    XYZ_path   = os.path.join(args.out_dir, args.out_xyz)
    DIAG_path  = os.path.join(args.out_dir, "step1_diagnostics.json")

    t = [0.0, -float(best.y_shift), 0.0]  # IMPORTANT: -y_shift (matches apply_alignment)

    align = {
        "version": 1,
        "phase": "step1_align_floor",
        "alignment": {
            "R_world_to_aligned": best.R.tolist(),
            "t_world_to_aligned": t,
            "y_shift": float(best.y_shift)
        },
        "convention": {
            "apply": "X_aligned = (R_world_to_aligned @ X_world) + t_world_to_aligned",
            "up_axis_aligned": [0.0, 1.0, 0.0],
            "units": "colmap_units"
        }
    }

    with open(ALIGN_PATH, "w", encoding="utf-8") as f:
        json.dump(align, f, indent=2)


        
    X_aligned = apply_alignment(X, best.R, best.y_shift)
    np.savetxt(XYZ_path, X_aligned, fmt="%.6f")

    # Diagnostics JSON (handy for logging / debugging / reproducibility)
    diag: Dict = {
        "phase": "step1_align_floor",
        "inputs": {"points": args.points, "images": args.images},
        "filters": {"error_max": args.error_max},
        "scene_bbox": {"min": mins.tolist(), "max": maxs.tolist(), "extent_diag": extent},
        "ransac": {
            "top_k": args.top_k,
            "iters": args.ransac_iters,
            "thr_ratio": args.thr_ratio,
            "thr": thr,
            "min_inliers_ratio": args.min_inliers_ratio,
            "min_inliers": min_inliers
        },
        "scoring": {
            "eps_ratio": args.eps_ratio,
            "eps": eps,
        },
        "extracted_planes": [
            {
                "index": i + 1,
                "inliers": p.inliers,
                "med_inlier_dist": p.med_inlier_dist,
                "normal": p.n.tolist(),
                "d": p.d,
                "centroid": p.centroid.tolist()
            } for i, p in enumerate(planes)
        ],
        "best_floor": {
            "plane_index_in_extracted_list": best.plane_index + 1,
            "sign": best.sign,
            "inliers": best.inliers,
            "med_inlier_dist": best.med_inlier_dist,
            "frac_cams_above": best.frac_cams_above,
            "frac_points_below": best.frac_points_below,
            "p01_y": best.p01_y,
            "p05_y": best.p05_y,
            "rotated_normal": best.rotated_normal.tolist(),
            "y_shift": best.y_shift,
            "R_align_floor": best.R.tolist(),
        },
        "outputs": {
            "floor_alignment_json": "floor_alignment.json",
            "aligned_xyz": args.out_xyz,
            "diagnostics_json": "step1_diagnostics.json"
        }
    }

    with open(DIAG_path, "w", encoding="utf-8") as f:
        json.dump(diag, f, indent=2)

    print("\nWrote:")
    print(" ", ALIGN_PATH)
    print(" ", XYZ_path)
    print(" ", DIAG_path)


if __name__ == "__main__":
    main()
