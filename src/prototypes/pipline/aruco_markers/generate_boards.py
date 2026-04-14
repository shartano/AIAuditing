import cv2
import numpy as np
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import mm
import os

# Create dictionary
dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)

def generate_charuco():
    """
    Generate a Charuco board and save it as a centered PDF on a Letter page. This will be used for camera calibration.
    """
    # Parameters
    squares_x = 5
    squares_y = 7
    square_length_mm = 30
    marker_length_mm = 20
    
    # Create Charuco board
    try:
        board = cv2.aruco.CharucoBoard(
            (squares_x, squares_y),
            square_length_mm,
            marker_length_mm,
            dictionary
        )
    except:
        board = cv2.aruco.CharucoBoard_create(
            squares_x,
            squares_y,
            square_length_mm,
            marker_length_mm,
            dictionary
        )

    # Generate board image at high resolution
    dpi = 300
    mm_per_inch = 25.4
    width_mm = squares_x * square_length_mm
    height_mm = squares_y * square_length_mm

    width_px = int(width_mm / mm_per_inch * dpi)
    height_px = int(height_mm / mm_per_inch * dpi)

    img = board.generateImage((width_px, height_px))

    # Save PDF cleanly
    os.makedirs("out", exist_ok=True)
    pdf_path = "out/charuco_5x7_30mm.pdf"

    c = canvas.Canvas(pdf_path, pagesize=letter)

    # Center the board on the page
    page_w, page_h = letter
    board_w_pts = width_mm * mm
    board_h_pts = height_mm * mm

    x = (page_w - board_w_pts) / 2
    y = (page_h - board_h_pts) / 2

    tmp_img = "out/temp_board.png"
    cv2.imwrite(tmp_img, img)

    c.drawImage(tmp_img, x, y, board_w_pts, board_h_pts)
    c.save()

    print("Saved:", pdf_path)


def generate_aruco(count):
    """
    Generate `count` random standalone ArUco markers (10 cm each).
    Each marker gets a unique random ID from the dictionary.

    Output: Each marker saved as a centered PDF in /out.
    """
    os.makedirs("out", exist_ok=True)

    # configuration
    marker_size_mm = 100        # 10 cm
    dpi = 300
    mm_per_inch = 25.4

    # number of IDs in the dictionary (e.g., DICT_4X4_50 → 50 IDs)
    dict_size = dictionary.bytesList.shape[0]

    # choose unique random marker IDs
    marker_ids = np.random.choice(dict_size, size=count, replace=False)

    for marker_id in marker_ids:
        # Size of rendered marker in pixels
        side_px = int(marker_size_mm / mm_per_inch * dpi)
        side_px = max(side_px, 600)  # ensure quality

        # Generate marker image
        marker_img = np.zeros((side_px, side_px), dtype=np.uint8)
        cv2.aruco.generateImageMarker(dictionary, int(marker_id), side_px, marker_img, borderBits=1)

        # Temporary PNG
        tmp_png_path = os.path.join("out", f"aruco_id{marker_id}_10cm.png")
        cv2.imwrite(tmp_png_path, marker_img)

        # PDF output
        pdf_path = os.path.join("out", f"aruco_id{marker_id}_10cm.pdf")
        c = canvas.Canvas(pdf_path, pagesize=letter)
        page_w, page_h = letter
        marker_size_pts = marker_size_mm * mm

        # Center on the page
        x = (page_w - marker_size_pts) / 2
        y = (page_h - marker_size_pts) / 2

        c.drawImage(tmp_png_path, x, y, marker_size_pts, marker_size_pts)
        c.showPage()
        c.save()

        print(f"Generated random ID {marker_id} → {pdf_path}")



if __name__ == "__main__":
    
    generate_charuco()

    # Set the input count here, default is 5
    generate_aruco(5)