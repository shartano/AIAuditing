import numpy as np

def load_phase1_transform(out_dir: str):
    """
    Loads the COLMAP->WORLD transform produced by Phase 1.
    Returns (R, y_shift).
    """
    R = np.loadtxt(f"{out_dir}/R_align_floor.txt", dtype=np.float64)
    with open(f"{out_dir}/T_floor_shift.txt", "r", encoding="utf-8") as f:
        line = f.readline().strip()
    y_shift = float(line.split("=")[1])
    return R, y_shift

def to_world_points(points_colmap: np.ndarray, R: np.ndarray, y_shift: float) -> np.ndarray:
    """
    points_colmap: Nx3
    returns points_world: Nx3
    """
    Pw = (R @ points_colmap.T).T
    Pw[:, 1] -= y_shift
    return Pw

def to_world_vec(vec_colmap: np.ndarray, R: np.ndarray) -> np.ndarray:
    """
    For directions (normals), do rotation only, no translation.
    vec_colmap: (...,3)
    """
    return (R @ vec_colmap.T).T
