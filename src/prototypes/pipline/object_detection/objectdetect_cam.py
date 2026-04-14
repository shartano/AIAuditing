import cv2
from ultralytics import YOLO
import os

def run_local_inference():
    # 1. Load the trained model
    model_path = "best.pt"

    try:
        model = YOLO(model_path)
    except Exception as e:
        print(f"Error loading model: {e}")
        print("Make sure you have run the training step first.")
        return

    # 2. Open the webcam
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("Error: Could not open webcam.")
        return

    print("Starting webcam... Press 'q' to exit.")

    # 3. Loop through frames
    while True:
        success, frame = cap.read()
        if not success:
            print("Failed to read frame.")
            break

        # 4. Run YOLOv8 Inference
        results = model(frame, conf=0.5)

        # 5. Get the annotated frame (with boxes)
        annotated_frame = results[0].plot()

        # 6. Create a Side-by-Side view (Raw Frame + AI Frame)
        # cv2.hconcat stacks images horizontally
        combined_view = cv2.hconcat([frame, annotated_frame])

        # 7. Display the combined window
        # We name the window "Raw Feed (Left) vs AI Detection (Right)"
        cv2.imshow("Raw Feed (Left) vs AI Detection (Right)", combined_view)

        # 8. Break loop if 'q' is pressed
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    # Cleanup
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    run_local_inference()