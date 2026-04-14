#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import deque
from typing import List, Tuple, Optional

import numpy as np


# -----------------------------
# IO
# -----------------------------
def load_xyz(path: str) -> np.ndarray:
    pts = np.loadtxt(path, dtype=np.float64)
    if pts.ndim == 1:
        pts = pts.reshape(1, -1)
    if pts.shape[1] < 3:
        raise ValueError(f"Expected at least 3 columns in {path}, got shape {pts.shape}")
    return pts[:, :3]


def save_json(path: str, obj) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)

def load_floor_alignment(path: str) -> Tuple[np.ndarray, np.ndarray]:
    """
    Loads Step1 floor_alignment.json and returns (R, t) where:
    X_aligned = (R @ X_world.T).T + t
    """
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    R = np.array(data["alignment"]["R_world_to_aligned"], dtype=np.float64)
    t = np.array(data["alignment"]["t_world_to_aligned"], dtype=np.float64)
    if R.shape != (3, 3):
        raise ValueError(f"Bad R shape in {path}: {R.shape}")
    if t.shape != (3,):
        raise ValueError(f"Bad t shape in {path}: {t.shape}")
    return R, t

def apply_rigid(X: np.ndarray, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    return (R @ X.T).T + t.reshape(1, 3)

# -----------------------------
# Floor selection (aligned frame)
# -----------------------------
def select_floor_points_aligned(Xw: np.ndarray,
                                low_pct: float = 10.0,
                                mad_k: float = 6.0,
                                thr_min_ratio: float = 0.0005) -> Tuple[np.ndarray, float, float]:
    """
    Robust floor selection in aligned frame (Y up).
    Uses the lowest low_pct% of Y to estimate floor height and band thickness via MAD.

    Returns (floor_points, y0, thr)
    """
    y = Xw[:, 1]
    n = len(y)
    k = max(200, int((low_pct / 100.0) * n))

    # Get lowest-k y values without sorting all points
    y_low = np.partition(y, k - 1)[:k]
    y0 = float(np.median(y_low))
    mad = float(np.median(np.abs(y_low - y0)) + 1e-12)

    extent = float(np.linalg.norm(np.ptp(Xw, axis=0)) + 1e-12)
    thr_min = thr_min_ratio * extent
    thr = max(mad_k * mad, thr_min)

    mask = np.abs(y - y0) <= thr
    return Xw[mask], y0, thr



# -----------------------------
# Occupancy grid + morphology + largest CC
# -----------------------------
def rasterize(points_xz: np.ndarray, cell: float, pad_cells: int = 5):
    x = points_xz[:, 0]
    z = points_xz[:, 1]
    x_min, x_max = float(x.min()), float(x.max())
    z_min, z_max = float(z.min()), float(z.max())

    x_min -= pad_cells * cell
    z_min -= pad_cells * cell
    x_max += pad_cells * cell
    z_max += pad_cells * cell

    W = int(math.ceil((x_max - x_min) / cell)) + 1
    H = int(math.ceil((z_max - z_min) / cell)) + 1

    grid = np.zeros((H, W), dtype=np.uint8)
    ix = np.floor((x - x_min) / cell).astype(np.int64)
    iz = np.floor((z - z_min) / cell).astype(np.int64)

    valid = (ix >= 0) & (ix < W) & (iz >= 0) & (iz < H)
    grid[iz[valid], ix[valid]] = 1
    return grid, (x_min, z_min)


def binary_dilate(grid: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return grid.copy()
    H, W = grid.shape
    out = np.zeros_like(grid)
    for dz in range(-r, r + 1):
        z0 = max(0, dz)
        z1 = min(H, H + dz)
        for dx in range(-r, r + 1):
            x0 = max(0, dx)
            x1 = min(W, W + dx)
            out[z0:z1, x0:x1] |= grid[z0 - dz:z1 - dz, x0 - dx:x1 - dx]
    return out


def binary_erode(grid: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return grid.copy()
    inv = 1 - grid
    dil = binary_dilate(inv, r)
    return 1 - dil


def binary_close(grid: np.ndarray, r: int) -> np.ndarray:
    return binary_erode(binary_dilate(grid, r), r)


def largest_connected_component(grid: np.ndarray) -> np.ndarray:
    H, W = grid.shape
    visited = np.zeros((H, W), dtype=np.uint8)
    best = None
    best_size = 0

    def neighbors(z, x):
        if z > 0: yield z - 1, x
        if z < H - 1: yield z + 1, x
        if x > 0: yield z, x - 1
        if x < W - 1: yield z, x + 1

    for z in range(H):
        for x in range(W):
            if grid[z, x] == 0 or visited[z, x]:
                continue
            q = deque([(z, x)])
            visited[z, x] = 1
            comp = [(z, x)]
            while q:
                cz, cx = q.popleft()
                for nz, nx in neighbors(cz, cx):
                    if grid[nz, nx] and not visited[nz, nx]:
                        visited[nz, nx] = 1
                        q.append((nz, nx))
                        comp.append((nz, nx))
            if len(comp) > best_size:
                best_size = len(comp)
                best = comp

    out = np.zeros_like(grid)
    if best is None:
        return out
    for z, x in best:
        out[z, x] = 1
    return out

def fill_holes(mask: np.ndarray) -> np.ndarray:
    """
    Fill holes in a binary mask using flood fill from border on the inverted mask.
    """
    H, W = mask.shape
    inv = (mask == 0).astype(np.uint8)
    visited = np.zeros_like(inv)
    q = deque()

    # start from borders where inv==1
    for x in range(W):
        if inv[0, x] and not visited[0, x]:
            q.append((0, x)); visited[0, x] = 1
        if inv[H-1, x] and not visited[H-1, x]:
            q.append((H-1, x)); visited[H-1, x] = 1
    for z in range(H):
        if inv[z, 0] and not visited[z, 0]:
            q.append((z, 0)); visited[z, 0] = 1
        if inv[z, W-1] and not visited[z, W-1]:
            q.append((z, W-1)); visited[z, W-1] = 1

    def nbrs(z, x):
        if z > 0: yield z-1, x
        if z < H-1: yield z+1, x
        if x > 0: yield z, x-1
        if x < W-1: yield z, x+1

    while q:
        z, x = q.popleft()
        for nz, nx in nbrs(z, x):
            if inv[nz, nx] and not visited[nz, nx]:
                visited[nz, nx] = 1
                q.append((nz, nx))

    # visited==1 are background-reachable zeros; holes are inv==1 and visited==0
    holes = (inv == 1) & (visited == 0)
    out = mask.copy()
    out[holes] = 1
    return out

# -----------------------------
# Boundary trace (Moore neighborhood)
# -----------------------------
def find_boundary_start(mask: np.ndarray) -> Tuple[int, int]:
    H, W = mask.shape
    for z in range(H):
        for x in range(W):
            if mask[z, x] == 0:
                continue
            if (z == 0 or mask[z - 1, x] == 0 or
                z == H - 1 or mask[z + 1, x] == 0 or
                x == 0 or mask[z, x - 1] == 0 or
                x == W - 1 or mask[z, x + 1] == 0):
                return z, x
    raise RuntimeError("No boundary found; mask may be empty.")


MOORE_DIRS = [
    (-1, -1), (-1, 0), (-1, 1),
    (0, 1),
    (1, 1), (1, 0), (1, -1),
    (0, -1)
]


def trace_boundary(mask: np.ndarray, max_steps: int = 2_000_000) -> List[Tuple[int, int]]:
    H, W = mask.shape
    start = find_boundary_start(mask)
    current = start
    prev = (start[0], start[1] - 1)

    boundary = [current]
    steps = 0

    def in_bounds(p):
        return 0 <= p[0] < H and 0 <= p[1] < W

    def dir_index(from_p, to_p):
        dz = to_p[0] - from_p[0]
        dx = to_p[1] - from_p[1]
        for i, (dzz, dxx) in enumerate(MOORE_DIRS):
            if dz == dzz and dx == dxx:
                return i
        return None

    while True:
        steps += 1
        if steps > max_steps:
            raise RuntimeError("Boundary trace exceeded max_steps.")

        idx = dir_index(current, prev)
        if idx is None:
            idx = 7
        scan_start = (idx + 1) % 8

        next_cell = None
        next_prev = None

        for k in range(8):
            i = (scan_start + k) % 8
            dz, dx = MOORE_DIRS[i]
            cand = (current[0] + dz, current[1] + dx)
            if in_bounds(cand) and mask[cand[0], cand[1]] == 1:
                next_cell = cand
                pdir = MOORE_DIRS[(i - 1) % 8]
                next_prev = (current[0] + pdir[0], current[1] + pdir[1])
                break

        if next_cell is None:
            break

        prev = next_prev
        current = next_cell

        if current == start:
            break
        boundary.append(current)

    return boundary


def boundary_cells_to_polygon_xz(boundary: List[Tuple[int, int]], origin_xz: Tuple[float, float], cell: float) -> np.ndarray:
    x0, z0 = origin_xz
    pts = []
    for z, x in boundary:
        X = x0 + (x + 0.5) * cell
        Z = z0 + (z + 0.5) * cell
        pts.append((X, Z))
    return np.array(pts, dtype=np.float64)


# -----------------------------
# Simplification (RDP)
# -----------------------------
def rdp_simplify(poly: np.ndarray, eps: float) -> np.ndarray:
    if len(poly) < 4:
        return poly

    def point_line_dist(p, a, b):
        ab = b - a
        denom = np.linalg.norm(ab)
        if denom < 1e-12:
            return np.linalg.norm(p - a)
        t = np.dot(p - a, ab) / (denom ** 2)
        proj = a + t * ab
        return np.linalg.norm(p - proj)

    def rdp(points):
        a = points[0]
        b = points[-1]
        dmax = -1.0
        imax = -1
        for i in range(1, len(points) - 1):
            d = point_line_dist(points[i], a, b)
            if d > dmax:
                dmax = d
                imax = i
        if dmax > eps:
            left = rdp(points[: imax + 1])
            right = rdp(points[imax:])
            return np.vstack([left[:-1], right])
        return np.vstack([a, b])

    pts = np.vstack([poly, poly[0]])
    simp = rdp(pts)
    if np.linalg.norm(simp[-1] - simp[0]) < 1e-9:
        simp = simp[:-1]
    return simp

def wall_planes_from_segments(segments_xz: List[Tuple[np.ndarray, np.ndarray]]) -> List[dict]:
    up = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    planes = []
    for (a, b) in segments_xz:
        edge = np.array([b[0] - a[0], 0.0, b[1] - a[1]], dtype=np.float64)
        elen = float(np.linalg.norm(edge))
        if elen < 1e-9:
            continue
        t = edge / elen
        n = np.cross(up, t)
        n_norm = np.linalg.norm(n)
        if n_norm < 1e-12:
            continue
        n = n / n_norm
        p0 = np.array([a[0], 0.0, a[1]], dtype=np.float64)
        planes.append({
            "id": f"wall_{len(planes) + 1}",
            "type": "wall",
            "normal": [float(n[0]), float(n[1]), float(n[2])],
            "point": [float(p0[0]), float(p0[1]), float(p0[2])]
        })
    return planes

# -----------------------------
# OBJ export (simple validation mesh)
# -----------------------------
def write_obj(path: str,
              floor_poly_xz: np.ndarray,
              wall_segments_xz: List[Tuple[np.ndarray, np.ndarray]],
              wall_height: float,
              write_floor: bool = True) -> None:
    verts = []
    faces = []

    def add_v(v):
        verts.append(v)
        return len(verts)

    # Walls from merged straight segments
    for (a, b) in wall_segments_xz:
        v0 = [float(a[0]), 0.0, float(a[1])]
        v1 = [float(b[0]), 0.0, float(b[1])]
        v2 = [float(b[0]), float(wall_height), float(b[1])]
        v3 = [float(a[0]), float(wall_height), float(a[1])]
        i0 = add_v(v0); i1 = add_v(v1); i2 = add_v(v2); i3 = add_v(v3)
        faces.append([i0, i1, i2])
        faces.append([i0, i2, i3])

    # Floor triangulation (concave-safe)
    if write_floor and len(floor_poly_xz) >= 3:
        poly = ensure_ccw(floor_poly_xz)
        base = [add_v([float(poly[i, 0]), 0.0, float(poly[i, 1])]) for i in range(len(poly))]
        tris = earclip_triangulate(poly)
        for (a, b, c) in tris:
            faces.append([base[a], base[b], base[c]])

    with open(path, "w", encoding="utf-8") as f:
        f.write("# room mesh (walls + floor)\n")
        for v in verts:
            f.write(f"v {v[0]} {v[1]} {v[2]}\n")
        for tri in faces:
            f.write(f"f {tri[0]} {tri[1]} {tri[2]}\n")


# helpers for floor and wall

def polygon_area(poly: np.ndarray) -> float:
    x = poly[:, 0]
    y = poly[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))

def ensure_ccw(poly: np.ndarray) -> np.ndarray:
    return poly if polygon_area(poly) > 0 else poly[::-1].copy()

def point_in_tri(p, a, b, c) -> bool:
    v0 = c - a
    v1 = b - a
    v2 = p - a
    den = v0[0]*v1[1] - v1[0]*v0[1]
    if abs(den) < 1e-12:
        return False
    u = (v2[0]*v1[1] - v1[0]*v2[1]) / den
    v = (v0[0]*v2[1] - v2[0]*v0[1]) / den
    return (u >= -1e-9) and (v >= -1e-9) and (u + v <= 1 + 1e-9)

def earclip_triangulate(poly: np.ndarray) -> List[Tuple[int, int, int]]:
    poly = ensure_ccw(poly)
    idx = list(range(len(poly)))
    tris = []

    def is_convex(a, b, c) -> bool:
        ab = poly[b] - poly[a]
        bc = poly[c] - poly[b]
        cross = ab[0]*bc[1] - ab[1]*bc[0]
        return cross > 1e-12

    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        ear_found = False
        m = len(idx)
        for i in range(m):
            a = idx[(i - 1) % m]
            b = idx[i]
            c = idx[(i + 1) % m]
            if not is_convex(a, b, c):
                continue
            A, B, C = poly[a], poly[b], poly[c]
            ok = True
            for j in range(m):
                v = idx[j]
                if v in (a, b, c):
                    continue
                if point_in_tri(poly[v], A, B, C):
                    ok = False
                    break
            if not ok:
                continue
            tris.append((a, b, c))
            del idx[i]
            ear_found = True
            break
        if not ear_found:
            break

    if len(idx) == 3:
        tris.append((idx[0], idx[1], idx[2]))
    return tris


def plane_from_3pts(p1, p2, p3):
    v1 = p2 - p1
    v2 = p3 - p1
    n = np.cross(v1, v2)
    nn = np.linalg.norm(n)
    if nn < 1e-12:
        return None
    n = n / nn
    d = -float(np.dot(n, p1))
    return n, d

def plane_point_dist(X, n, d):
    # signed distance
    return X @ n + d

def ransac_plane(X, tau, iters=2000, rng=None):
    if rng is None:
        rng = np.random.default_rng(0)
    N = len(X)
    if N < 3:
        return None

    best = None
    best_inliers = None
    best_count = 0

    for _ in range(iters):
        idx = rng.choice(N, size=3, replace=False)
        model = plane_from_3pts(X[idx[0]], X[idx[1]], X[idx[2]])
        if model is None:
            continue
        n, d = model
        dist = np.abs(plane_point_dist(X, n, d))
        inliers = dist <= tau
        c = int(inliers.sum())
        if c > best_count:
            best_count = c
            best = (n, d)
            best_inliers = inliers

    if best is None:
        return None
    return best[0], best[1], best_inliers

def extract_wall_planes(X, up=np.array([0.0,1.0,0.0]), *,
                        tau=0.05,
                        ny_max=0.15,
                        min_inliers=800,
                        min_yspan=1.5,
                        max_planes=12,
                        ransac_iters=2500,
                        rng_seed=0):
    """
    Iteratively extract vertical wall planes (largest + flattest).
    Returns list of dicts: {n,d,inliers_mask,score,yspan,count}
    """
    rng = np.random.default_rng(rng_seed)
    remaining = X
    planes = []

    for _ in range(max_planes):
        res = ransac_plane(remaining, tau=tau, iters=ransac_iters, rng=rng)
        if res is None:
            break
        n, d, inl = res

        # enforce vertical wall: normal mostly horizontal => |ny| small
        if abs(float(n[1])) > ny_max:
            # remove a small random subset to avoid infinite loop
            remaining = remaining[~inl] if inl.sum() > 0 else remaining
            continue

        P = remaining[inl]
        if len(P) < min_inliers:
            break

        y = P[:, 1]
        yspan = float(np.percentile(y, 95) - np.percentile(y, 5))
        if yspan < min_yspan:
            remaining = remaining[~inl]
            continue

        # flatness: residual spread
        dist = np.abs(plane_point_dist(P, n, d))
        resid = float(np.std(dist) + 1e-12)

        score = float(len(P) * yspan / resid)

        planes.append({
            "n": n,
            "d": float(d),
            "count": int(len(P)),
            "yspan": yspan,
            "resid_std": resid,
            "score": score
        })

        # peel off inliers and continue
        remaining = remaining[~inl]
        if len(remaining) < 3:
            break

    # sort best-first
    planes.sort(key=lambda p: p["score"], reverse=True)
    return planes

def plane_to_floor_line_xz(n, d):
    """
    Plane: n·[x,y,z] + d = 0
    On floor y=0 => (nx)x + (nz)z + d = 0
    returns (a,b,c) for ax + bz + c = 0
    """
    a = float(n[0])
    b = float(n[2])
    c = float(d)
    norm = math.hypot(a, b) + 1e-12
    return a / norm, b / norm, c / norm

def orient_line_inward(a, b, c, centroid_xz):
    x, z = centroid_xz
    s = a * x + b * z + c
    # want centroid to satisfy <= 0
    if s > 0:
        return -a, -b, -c
    return a, b, c

def intersect_lines(l1, l2):
    a1,b1,c1 = l1
    a2,b2,c2 = l2
    det = a1*b2 - a2*b1
    if abs(det) < 1e-10:
        return None
    x = (-c1*b2 - (-c2)*b1) / det
    z = (a1*(-c2) - a2*(-c1)) / det
    return np.array([x, z], dtype=np.float64)

def angle_of_normal(a, b):
    # normal angle in XZ
    return math.atan2(b, a)

def cluster_by_angle(lines, angle_deg=12.0):
    """
    Simple bin clustering by normal angle.
    Returns list of clusters, each cluster is list of line tuples.
    """
    ang = [angle_of_normal(a,b) for (a,b,c) in lines]
    # map to [0, pi) since (a,b,c) and (-a,-b,-c) already oriented inward
    ang = [(x % math.pi) for x in ang]
    thr = math.radians(angle_deg)

    clusters = []
    for line, t in sorted(zip(lines, ang), key=lambda x: x[1]):
        placed = False
        for cl in clusters:
            if abs(t - cl["theta"]) <= thr:
                cl["lines"].append(line)
                # update mean angle crudely
                cl["theta"] = (cl["theta"] + t) * 0.5
                placed = True
                break
        if not placed:
            clusters.append({"theta": t, "lines": [line]})
    return clusters

def pick_outer_lines_per_cluster(clusters, centroid_xz, keep_two=True):
    """
    For each orientation cluster, keep the most 'constraining' line(s)
    (farthest from centroid in the inward direction).
    """
    cx, cz = centroid_xz
    picked = []
    for cl in clusters:
        # For inward-oriented line ax+bz+c <= 0, value at centroid is <=0.
        # More negative => line is farther away and constrains a larger region (good as "outer wall").
        lines = cl["lines"]
        lines_sorted = sorted(lines, key=lambda L: (L[0]*cx + L[1]*cz + L[2]))  # most negative first
        picked.append(lines_sorted[0])
        if keep_two and len(lines_sorted) > 1:
            # sometimes there are returns/alcoves; keep second as well (optional)
            picked.append(lines_sorted[1])
    return picked

def polygon_from_ordered_lines(lines, centroid_xz):
    """
    Order lines by angle and intersect adjacent pairs to get polygon vertices.
    Assumes lines approximate a closed envelope.
    """
    ordered = sorted(lines, key=lambda L: angle_of_normal(L[0], L[1]))
    pts = []
    for i in range(len(ordered)):
        p = intersect_lines(ordered[i], ordered[(i+1) % len(ordered)])
        if p is not None:
            pts.append(p)
    if len(pts) < 3:
        return None
    poly = np.array(pts, dtype=np.float64)
    return poly

def footprint_from_floor_mask(floor_pts, cell, xz_extent, close_radius, simplify_ratio):
    # 1) project to XZ
    floor_xz = floor_pts[:, [0, 2]]

    # 2) grid -> close -> CC -> fill holes
    grid, origin = rasterize(floor_xz, cell=cell, pad_cells=5)
    grid_closed = binary_close(grid, r=close_radius)
    grid_main = largest_connected_component(grid_closed)
    grid_main = fill_holes(grid_main)
    if grid_main.sum() < 50:
        raise RuntimeError("Footprint mask too small (floor_mask).")

    # 3) boundary -> poly
    boundary_cells = trace_boundary(grid_main)
    poly_xz = boundary_cells_to_polygon_xz(boundary_cells, origin_xz=origin, cell=cell)

    # 4) simplify
    eps = simplify_ratio * xz_extent
    poly_xz_s = rdp_simplify(poly_xz, eps=eps)
    if len(poly_xz_s) < 3:
        raise RuntimeError("Simplified boundary has <3 vertices (floor_mask).")

    # segments = polygon edges (stable fallback default)
    segments = []
    min_len = max(2 * cell, 0.02 * xz_extent)
    for i in range(len(poly_xz_s)):
        a = poly_xz_s[i]
        b = poly_xz_s[(i + 1) % len(poly_xz_s)]
        if np.linalg.norm(b - a) >= min_len:
            segments.append((a, b))

    debug = {
        "boundary_verts_raw": int(len(poly_xz)),
        "boundary_verts_rdp": int(len(poly_xz_s)),
    }
    return poly_xz_s, segments, debug

def footprint_from_wall_bounds(Xw, floor_y_est, floor_thr, floor_xz_centroid, cell, xz_extent, args):
    # This function returns (poly_xz_s, segments, debug)
    # If it can't, it should raise RuntimeError so "auto" can fall back.

    # 1) wall candidate points: not floor band
    nonfloor = np.abs(Xw[:, 1] - floor_y_est) > floor_thr
    X_wall = Xw[nonfloor]
    if len(X_wall) < 500:
        raise RuntimeError("Too few non-floor points for wall RANSAC.")

    # 2) extract vertical wall planes
    tau = max(0.5 * cell, args.wall_ransac_tau_ratio * xz_extent)
    wall_planes = extract_wall_planes(
        X_wall,
        tau=tau,
        ny_max=args.wall_ny_max,
        min_inliers=args.wall_min_inliers,
        min_yspan=args.wall_min_yspan,
        max_planes=args.wall_max_planes,
        ransac_iters=2500,
        rng_seed=0
    )
    if len(wall_planes) < 3:
        raise RuntimeError("Not enough wall planes.")

    # 3) planes -> inward lines
    centroid_xz = floor_xz_centroid
    lines = []
    for wp in wall_planes:
        a, b, c = plane_to_floor_line_xz(wp["n"], wp["d"])
        a, b, c = orient_line_inward(a, b, c, centroid_xz)
        lines.append((a, b, c))

    # 4) cluster + pick outer + polygon
    clusters = cluster_by_angle(lines, angle_deg=args.wall_angle_cluster_deg)
    picked = pick_outer_lines_per_cluster(clusters, centroid_xz, keep_two=False)
    poly = polygon_from_ordered_lines(picked, centroid_xz)

    if poly is None or len(poly) < 3:
        raise RuntimeError("Failed to form polygon from wall bounds.")

    if len(poly) > 50:
        raise RuntimeError("Wall polygon too complex; likely spurious planes.")

    poly_xz_s = poly

    # 5) segments = polygon edges
    segments = []
    min_len = max(2 * cell, 0.02 * xz_extent)
    for i in range(len(poly_xz_s)):
        a = poly_xz_s[i]
        b = poly_xz_s[(i + 1) % len(poly_xz_s)]
        if np.linalg.norm(b - a) >= min_len:
            segments.append((a, b))

    debug = {
        "wall_planes_found": int(len(wall_planes)),
        "wall_lines_used": int(len(picked)),
        "poly_verts": int(len(poly_xz_s)),
        "tau": float(tau),
    }
    return poly_xz_s, segments, debug

def point_segment_distance_2d(P: np.ndarray, A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """
    P: Nx2 points, A/B: 2D endpoints
    returns Nx distances from each point to segment AB
    """
    AB = B - A
    denom = float(np.dot(AB, AB)) + 1e-12
    AP = P - A[None, :]
    t = (AP @ AB) / denom
    t = np.clip(t, 0.0, 1.0)
    proj = A[None, :] + t[:, None] * AB[None, :]
    return np.linalg.norm(P - proj, axis=1)


def outward_normal_for_edge_ccw(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """
    For a CCW polygon, outward normal is the RIGHT normal of edge direction.
    Edge direction t = B-A. Right normal = [t_z, -t_x] in XZ coordinates.
    Returns unit normal.
    """
    t = B - A
    n = np.array([t[1], -t[0]], dtype=np.float64)  # right normal
    nn = float(np.linalg.norm(n)) + 1e-12
    return n / nn


def ensure_ccw_xz(poly_xz: np.ndarray) -> np.ndarray:
    # reuse your polygon_area/ensure_ccw logic but for xz
    return ensure_ccw(poly_xz)


def extend_polygon_edges_with_vertical_support(
    poly_xz: np.ndarray,
    Xw: np.ndarray,
    floor_y_est: float,
    floor_thr: float,
    centroid_xz: np.ndarray,
    cell: float,
    xz_extent: float,
    corridor_cells: float = 4.0,
    min_pts: int = 60,
    quantile: float = 95.0,
    y_min_k: float = 3.0,
    max_outward_cells: float = 20.0,
):
    """
    Takes an initial footprint polygon (from floor mask), and pushes each edge outward
    using nearby vertical points (walls) to recover occluded/missing floor parts.

    Returns: (poly_xz_new, segments_new, debug_dict)
    """

    poly = ensure_ccw_xz(poly_xz)
    N = len(poly)
    if N < 3:
        raise RuntimeError("extend_polygon_edges_with_vertical_support: poly has < 3 verts")

    # 1) pick support points that are above floor band (and not too close to floor)
    y = Xw[:, 1]
    y_min = floor_y_est + max(y_min_k * floor_thr, 0.0)
    vertical_mask = y >= y_min
    P_xz = Xw[vertical_mask][:, [0, 2]]

    corridor = float(corridor_cells * cell)
    max_push = float(max_outward_cells * cell)

    lines = []
    edge_debug = []

    # for each edge, estimate outward boundary n·p <= s_wall
    for i in range(N):
        A = poly[i]
        B = poly[(i + 1) % N]
        mid = 0.5 * (A + B)

        n_out = outward_normal_for_edge_ccw(A, B)

        # sanity: centroid should be "inside": n_out·centroid <= n_out·mid for a decent poly
        # (not strictly guaranteed if poly is jaggy), so we only use this to orient if needed.
        if float(np.dot(n_out, centroid_xz - mid)) > 0:
            # centroid appears "outside" wrt this normal -> flip
            n_out = -n_out

        # corridor filter: points near this edge in XZ
        if len(P_xz) > 0:
            d = point_segment_distance_2d(P_xz, A, B)
            near = d <= corridor
            near_pts = P_xz[near]
        else:
            near_pts = np.empty((0, 2), dtype=np.float64)

        # baseline s from the original edge (so we never shrink inward)
        s0 = float(max(np.dot(n_out, A), np.dot(n_out, B)))

        used = False
        s_est = None

        if len(near_pts) >= min_pts:
            s_vals = near_pts @ n_out
            s_q = float(np.percentile(s_vals, quantile))

            # only push outward, cap how far
            s_est = min(s0 + max_push, max(s0, s_q))
            used = True
        else:
            s_est = s0  # no support -> keep as-is

        # line form: a x + b z + c = 0 where inside is <= 0
        a = float(n_out[0])
        b = float(n_out[1])
        c = float(-s_est)
        lines.append((a, b, c))

        edge_debug.append({
            "edge_i": i,
            "near_pts": int(len(near_pts)),
            "used_support": bool(used),
            "s0": float(s0),
            "s_est": float(s_est),
        })

    # 2) intersect consecutive lines to get new vertices
    new_pts = []
    bad_intersections = 0
    for i in range(N):
        p = intersect_lines(lines[i], lines[(i + 1) % N])
        if p is None or not np.all(np.isfinite(p)):
            bad_intersections += 1
            continue
        new_pts.append(p)

    if len(new_pts) < 3:
        raise RuntimeError("extend_polygon_edges_with_vertical_support: too few intersections; footprint too noisy or many parallel edges")

    poly_new = np.array(new_pts, dtype=np.float64)

    # 3) build segments from polygon edges (same as your stable fallback)
    segments = []
    min_len = max(2 * cell, 0.02 * xz_extent)
    for i in range(len(poly_new)):
        a = poly_new[i]
        b = poly_new[(i + 1) % len(poly_new)]
        if np.linalg.norm(b - a) >= min_len:
            segments.append((a, b))

    dbg = {
        "vertical_support_points": int(len(P_xz)),
        "corridor": float(corridor),
        "min_pts": int(min_pts),
        "quantile": float(quantile),
        "y_min": float(y_min),
        "max_push": float(max_push),
        "bad_intersections": int(bad_intersections),
        "edges": edge_debug,
        "segments": int(len(segments)),
        "verts": int(len(poly_new)),
    }
    return poly_new, segments, dbg

# -----------------------------
# Main
# -----------------------------
def main():
    ap = argparse.ArgumentParser()

    ap.add_argument("--aligned_xyz", type=str, default="out/points3D_aligned.xyz",
                    help="Aligned point cloud (x y z per line).")
    ap.add_argument("--xyz", type=str, default=None,
                help="Optional raw point cloud (world/COLMAP frame). Used only if --use_raw_xyz is set.")
    ap.add_argument("--floor_alignment_json", type=str, default="out/floor_alignment.json",
                    help="Path to Step1 floor_alignment.json (used with --use_raw_xyz).")
    ap.add_argument("--use_raw_xyz", action="store_true",
                    help="If set, ignore --aligned_xyz and align --xyz using --floor_alignment_json.")
    
    ap.add_argument("--out_dir", type=str, default="out",
                    help="Output directory (default: out).")

    ap.add_argument("--meters_per_colmap_unit", type=float, default=None,
                    help="If known, write metric scale into scene.json; otherwise keep unscaled.")

    # scale-free parameters (ratios of extents)
    ap.add_argument("--floor_low_pct", type=float, default=10.0,
                help="Use the lowest PCT of points by Y to estimate floor height and noise.")
    ap.add_argument("--floor_mad_k", type=float, default=6.0,
                    help="Floor band thickness = k * MAD of lowest points.")
    ap.add_argument("--floor_thr_min_ratio", type=float, default=0.0005,
                    help="Minimum floor band thickness as ratio of 3D extent (guards against too-thin band).")

    ap.add_argument("--cell_ratio", type=float, default=0.01,
                    help="Grid cell size = ratio * XZ extent. Typical 0.005–0.02.")
    ap.add_argument("--close_radius", type=int, default=2,
                    help="Morphological closing radius in grid cells.")
    ap.add_argument("--simplify_ratio", type=float, default=0.01,
                    help="RDP epsilon = ratio * XZ extent.")
    
    ap.add_argument("--height_percentile", type=float, default=95.0,
                    help="OBJ wall height estimate from percentile of Y.")
    ap.add_argument("--write_floor", action="store_true",
                    help="Include floor triangles in OBJ for visualization.")
    
    # more wall stuff
    ap.add_argument("--wall_ransac_tau_ratio", type=float, default=0.01,
                help="Wall plane RANSAC inlier threshold as ratio of XZ extent.")
    ap.add_argument("--wall_ny_max", type=float, default=0.15,
                    help="Max |ny| for a wall plane normal (vertical plane constraint).")
    ap.add_argument("--wall_min_inliers", type=int, default=800,
                    help="Minimum inliers for a wall plane.")
    ap.add_argument("--wall_min_yspan", type=float, default=1.5,
                    help="Minimum Y span (meters/units) for a wall plane to be considered a wall.")
    ap.add_argument("--wall_max_planes", type=int, default=12,
                    help="Max number of wall planes to extract.")
    ap.add_argument("--wall_angle_cluster_deg", type=float, default=12.0,
                    help="Angle bin size (deg) for grouping walls by orientation.")
    
    ap.add_argument("--footprint_method", type=str, default="auto",
                choices=["auto", "floor_mask", "wall_bounds"],
                help="How to compute room footprint. auto=try wall_bounds then fallback to floor_mask.")

    # new stuff for new wall extraction method
    ap.add_argument("--extend_edges_with_vertical_support", action="store_true",
                    help="After footprint is computed, push edges outward using nearby vertical points (helps with occlusions like toilets).")

    ap.add_argument("--support_corridor_cells", type=float, default=4.0,
                    help="How wide the corridor is around each footprint edge (in grid cells) to collect vertical support points.")

    ap.add_argument("--support_min_pts", type=int, default=60,
                    help="Minimum vertical points near an edge needed to trust an outward push.")

    ap.add_argument("--support_quantile", type=float, default=95.0,
                    help="Percentile of (n·p) used as the estimated wall position. Higher = more aggressive outward push.")

    ap.add_argument("--support_y_min_k", type=float, default=3.0,
                    help="Ignore points within (k * floor_thr) above floor when using vertical support points (filters fixture bases).")

    ap.add_argument("--support_max_outward_cells", type=float, default=20.0,
                    help="Maximum outward push per edge (in grid cells) to avoid outliers exploding the footprint.")

    args = ap.parse_args()

    if args.use_raw_xyz and not os.path.exists(args.floor_alignment_json):
        raise FileNotFoundError(f"Missing floor alignment JSON: {args.floor_alignment_json}")
    
    if (not args.use_raw_xyz) and (not os.path.exists(args.aligned_xyz)):
        raise FileNotFoundError(f"Missing aligned XYZ: {args.aligned_xyz}")

    os.makedirs(args.out_dir, exist_ok=True)

    if args.use_raw_xyz:
        if args.xyz is None:
            raise RuntimeError("--use_raw_xyz requires --xyz")
        X_raw = load_xyz(args.xyz)
        R, t = load_floor_alignment(args.floor_alignment_json)
        Xa = apply_rigid(X_raw, R, t)   # now aligned frame (Y up, floor near y=0)
    else:
        Xa = load_xyz(args.aligned_xyz) # already aligned

    if args.use_raw_xyz:
        align_dst = os.path.join(args.out_dir, "floor_alignment.json")
        if os.path.abspath(args.floor_alignment_json) != os.path.abspath(align_dst):
            with open(args.floor_alignment_json, "r", encoding="utf-8") as fsrc:
                align_data = json.load(fsrc)
            save_json(align_dst, align_data)

    # extents for relative thresholds
    extent3d = float(np.linalg.norm(np.ptp(Xa, axis=0)) + 1e-12)

    # 1) floor points
    floor_pts, floor_y_est, floor_thr = select_floor_points_aligned(
        Xa,
        low_pct=args.floor_low_pct,
        mad_k=args.floor_mad_k,
        thr_min_ratio=args.floor_thr_min_ratio
    )



    # Keep only the bottom portion of the selected floor band for footprint rasterization
    # This suppresses toe-kicks / fixture bases that sit slightly above the floor.
    y = floor_pts[:, 1]
    y_cut = np.percentile(y, 40)   # keep lowest 40% of floor-band points
    floor_pts = floor_pts[y <= y_cut]


    if len(floor_pts) < 200:
        raise RuntimeError(
        f"Too few floor points selected ({len(floor_pts)}). "
        f"Try increasing --floor_low_pct (currently {args.floor_low_pct}) or "
        f"--floor_thr_min_ratio (currently {args.floor_thr_min_ratio}), or reducing --floor_mad_k (currently {args.floor_mad_k})."
    )

    # 2) project to XZ
    floor_xz = floor_pts[:, [0, 2]]
    xz_extent = float(np.linalg.norm(np.ptp(floor_xz, axis=0)) + 1e-12)
    cell = args.cell_ratio * xz_extent
    centroid_xz = np.array([float(np.median(floor_xz[:,0])), float(np.median(floor_xz[:,1]))], dtype=np.float64)

    method_used = None
    method_debug = {}

    if args.footprint_method in ("auto", "wall_bounds"):
        try:
            poly_xz_s, merged_segments, method_debug = footprint_from_wall_bounds(
                Xa, floor_y_est, floor_thr, centroid_xz, cell, xz_extent, args
            )
            method_used = "wall_bounds"
        except Exception as e:
            if args.footprint_method == "wall_bounds":
                raise
            # auto fallback
            method_debug = {"wall_bounds_error": str(e)}

    if method_used is None:
        poly_xz_s, merged_segments, dbg_floor = footprint_from_floor_mask(
            floor_pts, cell, xz_extent,
            close_radius=args.close_radius,
            simplify_ratio=args.simplify_ratio
        )
        method_used = "floor_mask"
        method_debug.update(dbg_floor)

    # Optional: push footprint edges outward using nearby vertical points (walls)
    if args.extend_edges_with_vertical_support and method_used == "floor_mask":
        try:
            poly_xz_s2, merged_segments2, dbg_ext = extend_polygon_edges_with_vertical_support(
                poly_xz_s,
                Xa,
                floor_y_est=floor_y_est,
                floor_thr=floor_thr,
                centroid_xz=centroid_xz,
                cell=cell,
                xz_extent=xz_extent,
                corridor_cells=args.support_corridor_cells,
                min_pts=args.support_min_pts,
                quantile=args.support_quantile,
                y_min_k=args.support_y_min_k,
                max_outward_cells=args.support_max_outward_cells,
            )
            poly_xz_s = poly_xz_s2
            merged_segments = merged_segments2
            method_debug["edge_extension"] = dbg_ext
            method_used = "floor_mask+edge_extension"
        except Exception as e:
            method_debug["edge_extension_error"] = str(e)

    # 8) planes in required schema
    planes = [{
        "id": "floor",
        "type": "floor",
        "normal": [0.0, 1.0, 0.0],
        "point": [0.0, 0.0, 0.0]
    }]
    planes.extend(wall_planes_from_segments(merged_segments))


    # 8) units/scale block
    if args.meters_per_colmap_unit is None:
        units = "world_colmap_units"
        scale_obj = {"method": None, "meters_per_colmap_unit": None}
    else:
        units = "m"
        scale_obj = {"method": "aruco", "meters_per_colmap_unit": float(args.meters_per_colmap_unit)}

    # 9) canonical scene.json
    scene = {
        "version": "1.0",
        "units": units,
        "alignment": {
            "frame": "aligned_world",
            "source": "floor_alignment.json" if args.use_raw_xyz else "prealigned_xyz"
        },
        "scale": scale_obj,
        "frame": {"up": [0, 1, 0], "origin": "floor"},
        "footprint": {
            "polygon_xz": poly_xz_s.tolist(),
            "wall_segments_xz": [
                [[float(a[0]), float(a[1])], [float(b[0]), float(b[1])]]
                for (a, b) in merged_segments
            ]
        },
        "planes": planes
    }

    scene_path = os.path.join(args.out_dir, "scene.json")
    save_json(scene_path, scene)

    # 10) OBJ for MeshLab (validation)
    y = Xa[:, 1]
    h = float(np.percentile(y, args.height_percentile))
    if not np.isfinite(h) or h <= 0:
        h = float(np.max(y) - np.min(y))
    h = max(h, 0.1 * extent3d)

    obj_path = os.path.join(args.out_dir, "room.obj")
    write_obj(obj_path, floor_poly_xz=poly_xz_s, wall_segments_xz=merged_segments, wall_height=h, write_floor=args.write_floor)


    # 11) step2 diagnostics (record keeping)
    step2_diag = {
        "phase": "step2_footprint_walls",
        "inputs": {
            "aligned_xyz": args.aligned_xyz,
            "use_raw_xyz": bool(args.use_raw_xyz),
            "xyz": args.xyz,
            "floor_alignment_json": args.floor_alignment_json if args.use_raw_xyz else None
        },
        "params": {
            "floor_low_pct": args.floor_low_pct,
            "floor_mad_k": args.floor_mad_k,
            "floor_thr_min_ratio": args.floor_thr_min_ratio,
            "cell_ratio": args.cell_ratio,
            "close_radius": args.close_radius,
            "simplify_ratio": args.simplify_ratio,
            "height_percentile": args.height_percentile,
        },
        "scene_extent": {
            "extent_diag": extent3d
        },
        "floor": {
            "floor_y_est": float(floor_y_est),
            "floor_thr": float(floor_thr),
            "floor_points": int(len(floor_pts))
        },
        "footprint": {
            "cell": float(cell),
            "method": method_used,
            "method_debug": method_debug,
            "wall_segments_merged": int(len(merged_segments)),
            "poly_verts": int(len(poly_xz_s))
            },
        "outputs": {
            "scene_json": "scene.json",
            "room_obj": "room.obj",
            "step2_diagnostics_json": "step2_diagnostics.json",
        }
    }
    save_json(os.path.join(args.out_dir, "step2_diagnostics.json"), step2_diag)

    print("Wrote:")
    print(" -", scene_path)
    print(" -", obj_path)
    print(" -", os.path.join(args.out_dir, "step2_diagnostics.json"))


if __name__ == "__main__":
    main()
