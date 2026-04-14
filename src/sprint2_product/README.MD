# Sprint 2 Deployment-Ready Increment for Accessibility Audit System

Deployed on Expo for frontend, Supabase for backend, and Modal for machine learning pipeline.

Url: https://expo.dev/preview/update?message=frame+stuff&updateRuntimeVersion=1.0.0&createdAt=2026-02-11T02%3A48%3A39.591Z&slug=exp&projectId=05e20b63-fd34-4243-be2e-a6f5bdc0453a&group=04026596-c3f4-4164-a822-7641afc2f277

Scan the QR code to access the application.

### End-to-end flow:

1. User logs in to the system and starts a new audit.
2. User prints out one ArUco marker and places it on the floor, near a wall to scan. (Specfically a 4x4, ID 22, size 96mm marker. Any online ArUco marker generator can be used to create this marker, such as https://chev.me/arucogen/).
3. The user scans the room with their device, which captures images and spatial data.
4. Video frames are selected and processed then sent to the backend via API endpoints.
5. Backend reconstructs and rescales room geometry, detects objects, and checks for compliance with accessibility standards.
6. Generated report shows Red/Yellow/Green indicators for each accessibility requirement, along with detailed information on any issues found and recommendations for improvement.
7. Results are sent back to the frontend, where they are visualized in 3D and presented to the user for review.