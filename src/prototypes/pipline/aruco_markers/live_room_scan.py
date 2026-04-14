import cv2
import numpy as np
import os
import json
from datetime import datetime
import tkinter as tk
from tkinter import ttk, messagebox

# Try importing pygrabber for camera names
try:
    from pygrabber.dshow_graph import FilterGraph
    PYGRABBER_AVAILABLE = True
except ImportError:
    PYGRABBER_AVAILABLE = False

# ========= CONFIG =========

CALIB_PATH = "calibration_charuco.npz"
DICT = cv2.aruco.DICT_4X4_50
MARKER_SIZE_M = 0.096  # your measured 9.6 cm markers

# Output files
OUT_TRAJ_NPY = "camera_trajectory.npy"
OUT_SUMMARY_JSON = "scan_summary.json"

# Reference marker ID will be chosen automatically
ref_marker_id = None

# ==========================


def load_calibration(path):
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Calibration file not found: {path}\n"
            "Expected npz with 'cameraMatrix' and 'distCoeffs'."
        )
    data = np.load(path)
    K = data["cameraMatrix"]
    dist = data["distCoeffs"]
    return K, dist


def create_detector(dictionary):
    try:
        parameters = cv2.aruco.DetectorParameters()
        detector = cv2.aruco.ArucoDetector(dictionary, parameters)
        use_new = True
    except AttributeError:
        parameters = cv2.aruco.DetectorParameters_create()
        detector = parameters
        use_new = False
    return detector, use_new


def detect_markers(gray, dictionary, detector, use_new):
    if use_new:
        corners, ids, rejected = detector.detectMarkers(gray)
    else:
        corners, ids, rejected = cv2.aruco.detectMarkers(gray, dictionary)
    return corners, ids


def rt_to_matrix(rvec, tvec):
    """Convert (rvec, tvec) to a 4x4 homogeneous transform (marker -> camera)."""
    R, _ = cv2.Rodrigues(rvec)
    T = np.eye(4, dtype=float)
    T[:3, :3] = R
    T[:3, 3] = tvec.reshape(3)
    return T


def invert_transform(T):
    """Invert a 4x4 rigid transform."""
    R = T[:3, :3]
    t = T[:3, 3]
    T_inv = np.eye(4, dtype=float)
    T_inv[:3, :3] = R.T
    T_inv[:3, 3] = -R.T @ t
    return T_inv


def compute_stats(traj):
    xs = traj[:, 0]
    ys = traj[:, 1]
    zs = traj[:, 2]

    def stats(arr):
        return {
            "min": float(arr.min()),
            "max": float(arr.max()),
            "span": float(arr.max() - arr.min()),
            "mean": float(arr.mean()),
            "std": float(arr.std()),
        }

    x_stats = stats(xs)
    y_stats = stats(ys)
    z_stats = stats(zs)

    room_width = x_stats["span"]
    room_depth = z_stats["span"]
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
        "generated_at": datetime.now().isoformat(),
    }
    return summary


def summarize_markers(marker_obs, ref_marker_id):
    markers_world = {}

    if ref_marker_id is not None:
        markers_world[str(ref_marker_id)] = {
            "position": [0.0, 0.0, 0.0],
            "x_axis": [1.0, 0.0, 0.0],
            "y_axis": [0.0, 1.0, 0.0],
            "z_axis": [0.0, 0.0, 1.0],
            "normal": [0.0, 0.0, 1.0],
        }

    for mid, obs_list in marker_obs.items():
        if len(obs_list) == 0:
            continue

        pos_arr = np.stack([o["pos"] for o in obs_list], axis=0)
        x_arr = np.stack([o["x_axis"] for o in obs_list], axis=0)
        y_arr = np.stack([o["y_axis"] for o in obs_list], axis=0)
        z_arr = np.stack([o["z_axis"] for o in obs_list], axis=0)

        pos_mean = pos_arr.mean(axis=0)

        def avg_dir(arr):
            v = arr.mean(axis=0)
            n = np.linalg.norm(v)
            if n < 1e-8:
                return np.array([0.0, 0.0, 0.0], dtype=float)
            return v / n

        x_mean = avg_dir(x_arr)
        y_mean = avg_dir(y_arr)
        z_mean = avg_dir(z_arr)

        markers_world[str(mid)] = {
            "position": pos_mean.tolist(),
            "x_axis": x_mean.tolist(),
            "y_axis": y_mean.tolist(),
            "z_axis": z_mean.tolist(),
            "normal": z_mean.tolist(),
        }

    if len(markers_world) > 0:
        positions = np.array([m["position"] for m in markers_world.values()], dtype=float)
        min_xyz = positions.min(axis=0)
        max_xyz = positions.max(axis=0)
        size = max_xyz - min_xyz
        room_box = {
            "min": min_xyz.tolist(),
            "max": max_xyz.tolist(),
            "size": size.tolist(),
        }
    else:
        room_box = None

    return markers_world, room_box


def get_camera_selection():
    """
    Opens a GUI popup to select a camera by name using pygrabber.
    Returns the selected index (int) or None if cancelled.
    """
    if not PYGRABBER_AVAILABLE:
        print("pygrabber not installed. Run 'pip install pygrabber'. Defaulting to index 0.")
        return 0

    # 1. Get available cameras
    graph = FilterGraph()
    try:
        devices = graph.get_input_devices()
    except ValueError:
        devices = []

    if not devices:
        print("No cameras found via pygrabber.")
        return None

    device_map = {name: i for i, name in enumerate(devices)}
    selected_index = None

    def on_confirm():
        nonlocal selected_index
        choice = combo.get()
        if choice in device_map:
            selected_index = device_map[choice]
            root.destroy()
        else:
            messagebox.showerror("Error", "Please select a valid camera.")

    def on_close():
        root.destroy()

    # 2. Setup GUI
    root = tk.Tk()
    root.title("Select Camera")
    root.geometry("350x150")

    # Center window on screen (optional polish)
    root.eval('tk::PlaceWindow . center')

    tk.Label(root, text="Select Video Input Device:", font=("Arial", 10, "bold"), pady=10).pack()

    combo = ttk.Combobox(root, values=devices, state="readonly", width=40)
    combo.pack(pady=5)
    combo.current(0)

    btn = tk.Button(root, text="Start Scan", command=on_confirm, bg="#dddddd", padx=20, pady=5)
    btn.pack(pady=15)

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()

    return selected_index


def main():
    global ref_marker_id

    # 1. Load calibration
    try:
        K, dist = load_calibration(CALIB_PATH)
        print("Loaded calibration from", CALIB_PATH)
    except FileNotFoundError as e:
        print(e)
        return

    # 2. Select Camera (Popup)
    print("Launching camera selector...")
    selected_index = get_camera_selection()

    if selected_index is None:
        print("Camera selection cancelled.")
        return

    print(f"Opening Camera Index {selected_index}...")
    cap = cv2.VideoCapture(selected_index)

    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera {selected_index}")

    # 3. Setup ArUco
    dictionary = cv2.aruco.getPredefinedDictionary(DICT)
    detector, use_new = create_detector(dictionary)

    print(f"Camera active. Press 'q' to stop and save trajectory + summary.")

    trajectory = []
    marker_obs = {}
    all_marker_ids = set()
    ref_marker_id = None

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        corners, ids = detect_markers(gray, dictionary, detector, use_new)

        if ids is not None and len(ids) > 0:
            cv2.aruco.drawDetectedMarkers(frame, corners, ids)
            ids_flat = ids.flatten().astype(int)
            all_marker_ids.update(int(i) for i in ids_flat)

            rvecs, tvecs, _ = cv2.aruco.estimatePoseSingleMarkers(corners, MARKER_SIZE_M, K, dist)

            # Auto-select reference
            if ref_marker_id is None:
                ref_marker_id = int(ids_flat[0])
                print(f"[INFO] Selected marker {ref_marker_id} as world reference.")

            # Process reference marker
            if ref_marker_id in ids_flat:
                idx_ref = list(ids_flat).index(ref_marker_id)
                r_ref = rvecs[idx_ref]
                t_ref = tvecs[idx_ref]

                # Fix dimensions if necessary
                if r_ref.ndim == 2: r_ref, t_ref = r_ref[0], t_ref[0]

                # T_cam_ref (marker -> camera)
                T_cam_ref = rt_to_matrix(r_ref, t_ref)
                # T_ref_cam (camera in ref frame)
                T_ref_cam = invert_transform(T_cam_ref)

                cam_pos = T_ref_cam[:3, 3]
                trajectory.append(cam_pos.copy())

                # Draw axes
                cv2.drawFrameAxes(frame, K, dist, r_ref, t_ref, MARKER_SIZE_M * 0.5)

                # Overlay Text
                x, y, z = cam_pos
                cv2.putText(frame, f"Cam@ID{ref_marker_id}: {x:.2f}, {y:.2f}, {z:.2f}", (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

                # Process other markers relative to reference
                for k, mid in enumerate(ids_flat):
                    mid = int(mid)
                    if mid == ref_marker_id: continue

                    r_k, t_k = rvecs[k], tvecs[k]
                    if r_k.ndim == 2: r_k, t_k = r_k[0], t_k[0]

                    T_cam_k = rt_to_matrix(r_k, t_k)
                    T_ref_k = T_ref_cam @ T_cam_k

                    obs = {
                        "pos": T_ref_k[:3, 3],
                        "x_axis": T_ref_k[:3, 0],
                        "y_axis": T_ref_k[:3, 1],
                        "z_axis": T_ref_k[:3, 2],
                    }
                    marker_obs.setdefault(mid, []).append(obs)
            else:
                cv2.putText(frame, f"Ref ID {ref_marker_id} lost", (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        else:
            cv2.putText(frame, "No markers", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

        cv2.putText(frame, f"Samples: {len(trajectory)}", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        cv2.imshow("Live ArUco Room Scan", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()

    if len(trajectory) == 0:
        print("No poses recorded. Exiting.")
        return

    # Save Data
    traj = np.vstack(trajectory)
    np.save(OUT_TRAJ_NPY, traj)
    print(f"Saved trajectory to {OUT_TRAJ_NPY}")

    traj_stats = compute_stats(traj)
    markers_world, room_box = summarize_markers(marker_obs, ref_marker_id)

    localised_ids = sorted(int(k) for k in markers_world.keys())

    summary = {
        "generated_at": datetime.now().isoformat(),
        "reference_marker_id": int(ref_marker_id) if ref_marker_id else None,
        "marker_ids_localised": localised_ids,
        "room_box_from_markers_m": room_box,
        "trajectory_stats": traj_stats,
    }

    with open(OUT_SUMMARY_JSON, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\nSaved summary JSON to: {OUT_SUMMARY_JSON}")

if __name__ == "__main__":
    main()