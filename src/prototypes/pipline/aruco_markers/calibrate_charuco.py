import cv2
import numpy as np
import glob

# === Your parameters ===
squares_x = 5
squares_y = 7
square_length = 0.03   # meters
marker_length = 0.02   # meters

dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)

try:
    board = cv2.aruco.CharucoBoard(
        (squares_x, squares_y),
        square_length,
        marker_length,
        dictionary
    )
except:
    board = cv2.aruco.CharucoBoard_create(
        squares_x, squares_y, square_length, marker_length, dictionary
    )

# === Load images ===
images = []
for ext in ("*.png", "*.jpg", "*.jpeg"):
    images.extend(glob.glob(f"calib_images/{ext}"))

all_corners = []
all_ids = []
image_size = None

for fname in images:
    img = cv2.imread(fname)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    image_size = gray.shape[::-1]

    corners, ids, _ = cv2.aruco.detectMarkers(gray, dictionary)

    if ids is not None and len(ids) > 0:
        # Refine
        cv2.aruco.refineDetectedMarkers(
            gray, board, corners, ids, rejectedCorners=None
        )

        # Interpolate Charuco corners
        ret, charuco_corners, charuco_ids = cv2.aruco.interpolateCornersCharuco(
            corners, ids, gray, board
        )

        if charuco_ids is not None and len(charuco_ids) > 3:
            all_corners.append(charuco_corners)
            all_ids.append(charuco_ids)

# === Run calibration ===
retval, cameraMatrix, distCoeffs, rvecs, tvecs = cv2.aruco.calibrateCameraCharuco(
    all_corners,
    all_ids,
    board,
    image_size,
    None,
    None
)

print("Calibration RMS error:", retval)
print("Camera matrix:\n", cameraMatrix)
print("Distortion coeffs:\n", distCoeffs)

# === Save parameters ===
np.savez("calibration_charuco.npz", 
         cameraMatrix=cameraMatrix,
         distCoeffs=distCoeffs)

print("Saved calibration to calibration_charuco.npz")
