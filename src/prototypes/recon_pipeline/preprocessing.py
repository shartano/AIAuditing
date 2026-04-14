#!/usr/bin/env python3
"""
Preprocessing check: scan frames for ArUco marker detection before running
any reconstruction pipeline steps.

Exits with code 0 if at least one marker detection is found.
Exits with code 1 if no markers are detected in any frame (aborts pipeline).
"""

import argparse
import os
import sys
from typing import Optional

import cv2

ARUCO_DICT_MAP = {
    "DICT_4X4_50":   cv2.aruco.DICT_4X4_50,
    "DICT_4X4_100":  cv2.aruco.DICT_4X4_100,
    "DICT_4X4_250":  cv2.aruco.DICT_4X4_250,
    "DICT_4X4_1000": cv2.aruco.DICT_4X4_1000,
    "DICT_5X5_50":   cv2.aruco.DICT_5X5_50,
    "DICT_5X5_100":  cv2.aruco.DICT_5X5_100,
    "DICT_5X5_250":  cv2.aruco.DICT_5X5_250,
    "DICT_5X5_1000": cv2.aruco.DICT_5X5_1000,
    "DICT_6X6_50":   cv2.aruco.DICT_6X6_50,
    "DICT_6X6_100":  cv2.aruco.DICT_6X6_100,
    "DICT_6X6_250":  cv2.aruco.DICT_6X6_250,
    "DICT_6X6_1000": cv2.aruco.DICT_6X6_1000,
    "DICT_7X7_50":   cv2.aruco.DICT_7X7_50,
    "DICT_7X7_100":  cv2.aruco.DICT_7X7_100,
    "DICT_7X7_250":  cv2.aruco.DICT_7X7_250,
    "DICT_7X7_1000": cv2.aruco.DICT_7X7_1000,
}

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}


def check_aruco_in_frames(
    images_dir: str,
    aruco_dict_name: str = "DICT_4X4_50",
    marker_id: int = -1,
    min_side_px: float = 20.0,
    stop_on_first: bool = True,
) -> Optional[str]:
    """
    Scan all image frames in images_dir for an ArUco marker.

    Args:
        images_dir:      Directory containing frame images.
        aruco_dict_name: ArUco dictionary to use.
        marker_id:       Specific marker ID to look for, or -1 to accept any.
        min_side_px:     Minimum marker side length in pixels to count as a valid detection.
        stop_on_first:   If True, return as soon as one detection is found.

    Returns:
        The filename of the first frame containing the marker, or None if not found.
    """
    if aruco_dict_name not in ARUCO_DICT_MAP:
        raise ValueError(
            f"Unknown aruco dict '{aruco_dict_name}'. "
            f"Options: {list(ARUCO_DICT_MAP.keys())}"
        )

    aruco_dict = cv2.aruco.getPredefinedDictionary(ARUCO_DICT_MAP[aruco_dict_name])
    params = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(aruco_dict, params)

    frame_files = sorted(
        f for f in os.listdir(images_dir)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS
    )

    if not frame_files:
        print(f"[preprocessing] No image files found in: {images_dir}", flush=True)
        return None

    print(f"[preprocessing] Scanning {len(frame_files)} frames for ArUco marker "
          f"(dict={aruco_dict_name}, marker_id={'any' if marker_id == -1 else marker_id}) ...",
          flush=True)

    detections_found = 0

    for fname in frame_files:
        path = os.path.join(images_dir, fname)
        im = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if im is None:
            print(f"[preprocessing]   WARNING: could not read {fname}, skipping", flush=True)
            continue

        corners_list, ids, _ = detector.detectMarkers(im)
        if ids is None or len(ids) == 0:
            continue

        ids_flat = ids.flatten().astype(int)
        for corners, mid in zip(corners_list, ids_flat):
            if marker_id != -1 and mid != marker_id:
                continue

            c = corners.reshape(-1, 2)
            if c.shape != (4, 2):
                continue

            import numpy as np
            sides = [
                float(np.linalg.norm(c[0] - c[1])),
                float(np.linalg.norm(c[1] - c[2])),
                float(np.linalg.norm(c[2] - c[3])),
                float(np.linalg.norm(c[3] - c[0])),
            ]
            side_px = float(np.median(sides))

            if side_px < min_side_px:
                continue

            print(
                f"[preprocessing]   FOUND marker id={mid} in {fname} "
                f"(side={side_px:.1f}px)",
                flush=True,
            )
            detections_found += 1

            if stop_on_first:
                return fname

    if detections_found == 0:
        return None

    return f"({detections_found} detections across frames)"


def main():
    ap = argparse.ArgumentParser(
        description="Precheck: verify at least one ArUco marker is visible before reconstruction."
    )
    ap.add_argument(
        "--images_dir", required=True,
        help="Directory containing frame images to scan."
    )
    ap.add_argument(
        "--aruco_dict", default="DICT_4X4_50",
        help="ArUco dictionary name (default: DICT_4X4_50)."
    )
    ap.add_argument(
        "--marker_id", type=int, default=-1,
        help="Marker ID to look for. Use -1 to accept any marker (default: -1)."
    )
    ap.add_argument(
        "--min_side_px", type=float, default=20.0,
        help="Minimum marker side length in pixels to count as a valid detection (default: 20)."
    )
    ap.add_argument(
        "--scan_all", action="store_true",
        help="Scan all frames instead of stopping at the first detection."
    )
    args = ap.parse_args()

    if not os.path.isdir(args.images_dir):
        print(f"[preprocessing] ERROR: images_dir not found: {args.images_dir}", flush=True)
        sys.exit(1)

    result = check_aruco_in_frames(
        images_dir=args.images_dir,
        aruco_dict_name=args.aruco_dict,
        marker_id=args.marker_id,
        min_side_px=args.min_side_px,
        stop_on_first=not args.scan_all,
    )

    if result is None:
        print(
            "[preprocessing] FAIL: No ArUco marker detected in any frame. "
            "Aborting pipeline.",
            flush=True,
        )
        sys.exit(1)

    print(
        f"[preprocessing] PASS: ArUco marker detected. Reconstruction may proceed.",
        flush=True,
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
