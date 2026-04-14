import json
import numpy as np


def calculate_distance(p1, p2):
    if p1 is None or p2 is None:
        return None
    return float(np.linalg.norm(np.array(p1) - np.array(p2)))


def get_objects_by_types(objects, type_list):
    matches = []
    for obj in objects:
        if obj.get("type") in type_list:
            matches.append(obj)
    return matches


def get_first_object(objects, type_list):
    matches = get_objects_by_types(objects, type_list)
    return matches[0] if matches else None


def extract_room_data(json_file_path):
    with open(json_file_path, 'r') as f:
        scene = json.load(f)

    # --- 1. HELPERS (Direct Metric Reading) ---
    def get_max_height(obj):
        if not obj or "bbox_aligned" not in obj: return None
        return obj["bbox_aligned"]["max"][1]

    def get_centroid_height(obj):
        if not obj or "position" not in obj: return None
        return obj["position"][1]

    def get_pos_xz(obj):
        if not obj or "position" not in obj: return None
        return np.array([obj["position"][0], obj["position"][2]])

    objects = scene.get("objects", [])

    # --- 2. FIND OBJECTS ---
    toilet_obj = get_first_object(objects, ["toilet"])
    grab_bar_obj = get_first_object(objects, ["grab_handle"])
    dispensers_list = get_objects_by_types(objects, ["soap", "towel"])
    button_obj = get_first_object(objects, ["emergency_button"])
    door_handle_obj = get_first_object(objects, ["door_handle"])

    # --- 3. EXTRACT METRICS & APPLY ADJUSTED HEURISTICS ---

    # TOILET: TIERED TANK LOGIC (Less Aggressive)
    toilet_height = get_max_height(toilet_obj)
    toilet_pos = toilet_obj["position"] if toilet_obj else None

    if toilet_height:
        # CASE 1: VERY TALL TANK (> 0.75m)
        # Was 0.30m, now reduced to 0.28m to avoid dropping too low.
        if toilet_height > 0.75:
            print(f"   ℹ️  Tall Tank Detected ({toilet_height:.2f}m). Subtracting 0.28m.")
            toilet_height -= 0.28

        # CASE 2: LOW/COMPACT TANK (0.60m - 0.75m)
        # Was 0.25m, now reduced to 0.20m.
        # Example: 0.65m - 0.20m = 0.45m (PASS).
        elif toilet_height > 0.60:
            print(f"   ℹ️  Low Tank Detected ({toilet_height:.2f}m). Subtracting 0.20m.")
            toilet_height -= 0.20

        # CASE 3: COMMERCIAL (< 0.60m)
        # No subtraction.
        else:
            pass

    # GRAB BAR
    grab_bar_height = get_centroid_height(grab_bar_obj)
    grab_bar_pos = grab_bar_obj["position"] if grab_bar_obj else None

    # BUTTON
    button_height = get_centroid_height(button_obj)
    button_pos = button_obj["position"] if button_obj else None

    # DISPENSER
    dispenser_height = get_centroid_height(dispensers_list[0]) if dispensers_list else None
    dispenser_pos = dispensers_list[0]["position"] if dispensers_list else None

    # Distance
    bar_to_toilet_dist = calculate_distance(grab_bar_pos, toilet_pos)

    # --- 4. OBSTACLE-AWARE TURNING DIAMETER ---
    footprint = scene.get("footprint", {}).get("polygon_xz", [])
    turning_diameter = 0.0

    if footprint:
        xs = [p[0] for p in footprint]
        zs = [p[1] for p in footprint]
        # 1. Base Room Dimensions
        room_width = max(xs) - min(xs)
        room_depth = max(zs) - min(zs)
        wall_diameter = min(room_width, room_depth)

        # 2. Obstacle Check
        room_center = np.array([(min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2])
        min_dist_to_obj = float('inf')

        for obj in objects:
            # Ignore high objects (mirrors, etc.)
            bbox_min_y = obj.get("bbox_aligned", {}).get("min", [0, 0, 0])[1]
            if bbox_min_y > 1.0:
                continue

            pos_xz = get_pos_xz(obj)
            if pos_xz is not None:
                dist = np.linalg.norm(room_center - pos_xz)
                if dist < min_dist_to_obj:
                    min_dist_to_obj = dist

        # Radius is limited by nearest wall (diameter/2) OR nearest object
        available_radius = min(wall_diameter / 2, min_dist_to_obj)
        turning_diameter = available_radius * 2

    # --- 5. OUTPUT ---
    world_state = {
        "toilet": {"position": toilet_pos, "height_m": toilet_height},
        "grab_bar": {"position": grab_bar_pos, "height_m": grab_bar_height, "distance_to_toilet_m": bar_to_toilet_dist,
                     "is_obstructed": False},
        "dispenser": {"position": dispenser_pos, "height_m": dispenser_height},
        "emergency_button": {"position": button_pos, "height_m": button_height},
        "door": {"position": door_handle_obj["position"] if door_handle_obj else None, "width_m": None},
        "room_clearance": {"diameter_m": turning_diameter}
    }

    return world_state