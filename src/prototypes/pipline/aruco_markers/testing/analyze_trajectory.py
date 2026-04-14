import os
import json
import numpy as np

BASE_DIR = os.path.dirname(__file__)
TRAJ_PATH = os.path.join(BASE_DIR, "camera_trajectory.npy")

if not os.path.exists(TRAJ_PATH):
    raise FileNotFoundError(f"Could not find {TRAJ_PATH}")

traj = np.load(TRAJ_PATH)  # shape (N, 3)
if traj.ndim != 2 or traj.shape[1] != 3:
    raise ValueError(f"Trajectory has wrong shape: {traj.shape}")

print(f"Loaded {traj.shape[0]} camera poses")

xs = traj[:, 0]
ys = traj[:, 1]
zs = traj[:, 2]

def stats(name, arr):
    return {
        "min": float(arr.min()),
        "max": float(arr.max()),
        "span": float(arr.max() - arr.min()),
        "mean": float(arr.mean()),
        "std": float(arr.std()),
    }

x_stats = stats("x", xs)
y_stats = stats("y", ys)
z_stats = stats("z", zs)

print("X stats (meters):", x_stats)
print("Y stats (meters):", y_stats)
print("Z stats (meters):", z_stats)

# Treat x–z plane as horizontal span, y as height-ish
room_width  = x_stats["span"]   # along board-x
room_depth  = z_stats["span"]   # along board-z
cam_height_mean = abs(y_stats["mean"])

summary = {
    "num_poses": int(traj.shape[0]),
    "x_stats": x_stats,
    "y_stats": y_stats,
    "z_stats": z_stats,
    "approx_room_box_m": {
        "width_x": room_width,
        "depth_z": room_depth,
        "cam_height_mean": cam_height_mean,
    },
}

print("\n=== Approx scanned volume (meters) ===")
print(f"Width  (|Δx|): {room_width:.3f} m")
print(f"Depth  (|Δz|): {room_depth:.3f} m")
print(f"Mean |camera height|: {cam_height_mean:.3f} m")

# Save JSON for the simulation teammate
OUT_JSON = os.path.join(BASE_DIR, "scan_summary.json")
with open(OUT_JSON, "w") as f:
    json.dump(summary, f, indent=2)

print(f"\nSaved summary JSON to: {OUT_JSON}")
