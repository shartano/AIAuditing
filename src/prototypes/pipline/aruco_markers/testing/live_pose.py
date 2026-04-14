import os
import cv2
import numpy as np

# === 1. Load calibration (relative to this file) ===
base = os.path.dirname(__file__)
calib_path = os.path.join(base, "calibration_charuco.npz")

calib = np.load(calib_path)
cameraMatrix = calib["cameraMatrix"]
distCoeffs = calib["distCoeffs"]

print("Loaded calibration:")
print("cameraMatrix:\n", cameraMatrix)
print("distCoeffs:\n", distCoeffs)

# === 2. ArUco setup ===
dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
parameters = cv2.aruco.DetectorParameters()

try:
    detector = cv2.aruco.ArucoDetector(dictionary, parameters)
    use_class_detector = True
except AttributeError:
    use_class_detector = False
    print("Using legacy detectMarkers API")

MARKER_LENGTH = 0.04  # 40 mm markers in meters

# store camera positions over time
camera_trajectory = []   # list of (x, y, z)

# === 3. Open camera ===
cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("Error: could not open camera")
    raise SystemExit

print("Press ESC to quit, 'w' to write trajectory to file")

while True:
    ret, frame = cap.read()
    if not ret:
        print("Failed to grab frame")
        break

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    if use_class_detector:
        corners, ids, rejected = detector.detectMarkers(gray)
    else:
        corners, ids, rejected = cv2.aruco.detectMarkers(
            gray, dictionary, parameters=parameters
        )

    if ids is not None and len(ids) > 0:
        # Draw marker borders
        cv2.aruco.drawDetectedMarkers(frame, corners, ids)

        # Pose of each marker *in camera coordinates*
        rvecs, tvecs, _ = cv2.aruco.estimatePoseSingleMarkers(
            corners, MARKER_LENGTH, cameraMatrix, distCoeffs
        )

        # Use the first marker as the reference for world coordinates
        rvec = rvecs[0]
        tvec = tvecs[0]

        # Draw axes on every marker (for visualization)
        for rv, tv in zip(rvecs, tvecs):
            cv2.drawFrameAxes(
                frame, cameraMatrix, distCoeffs, rv, tv, MARKER_LENGTH * 0.5
            )

        # ----- NEW: compute camera pose in marker/world coords -----
        R, _ = cv2.Rodrigues(rvec)       # 3x3
        R_inv = R.T
        t = tvec.reshape(3, 1)          # (3,1)

        cam_pos = -R_inv @ t            # camera position in world coords
        cam_pos = cam_pos.flatten()     # (x, y, z)

        camera_trajectory.append(cam_pos.copy())

        # Console debug
        print(
            f"First marker ID: {ids[0][0]} "
            f"camera_pos (m): x={cam_pos[0]:.3f}, y={cam_pos[1]:.3f}, z={cam_pos[2]:.3f}"
        )

        # Overlay a little HUD
        hud = f"ID {ids[0][0]}  cam z={cam_pos[2]:.2f}m"
        cv2.putText(
            frame,
            hud,
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.0,
            (0, 255, 0),
            2,
            cv2.LINE_AA,
        )

    cv2.imshow("Aruco pose (camera in board coords)", frame)

    key = cv2.waitKey(1) & 0xFF
    if key == 27:  # ESC
        break
    elif key == ord('w'):
        # Save trajectory so far
        traj = np.array(camera_trajectory)
        out_path = os.path.join(base, "camera_trajectory.npy")
        np.save(out_path, traj)
        print(f"Saved trajectory with {len(traj)} poses to {out_path}")

cap.release()
cv2.destroyAllWindows()
