"""
Compliance evaluation.

Used both as:
  - CLI tool
  - callable module from the Modal pipeline

It reads a reconstructed + scaled `scene.json`, extracts world metrics via `extractor.py`,
then evaluates those metrics against `standards.json` and appends results back into the scene.

Output JSON fields appended:
  - compliance_report: list[dict]
  - world_state_debug: dict (inputs to the rule checks)

CLI examples:
  python compliance_check.py --scene scene.json --standards standards.json --out scene.json
  python compliance_check.py --scene scene.json --standards standards.json   # overwrites scene.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Tuple

import extractor  # local module (extractor.py)


def _load_json(path: Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _evaluate_compliance(value: Any, rules: Dict[str, Any]) -> Tuple[str, str]:
    if value is None:
        return "unknown", "Data not detected or skipped"
    if not isinstance(value, (int, float)):
        return "unknown", "Metric is non-numeric"

    g = rules.get("green", {})
    is_green = True
    if "min" in g and value < g["min"]:
        is_green = False
    if "max" in g and value > g["max"]:
        is_green = False
    if "value" in g and value != g["value"]:
        is_green = False
    if is_green:
        return "green", "Compliant (Best Practice)"

    if "yellow" in rules:
        y = rules["yellow"]
        is_yellow = True
        if "min" in y and value < y["min"]:
            is_yellow = False
        if "max" in y and value > y["max"]:
            is_yellow = False
        if is_yellow:
            return "yellow", "Compliant (Minimum Standard)"

    return "red", "Non-Compliant / Barrier Detected"

def _get_recommendation(check_key: str) -> str:

    recommendations = {
        "turning_radius": "Remove obstructions (furniture, bins) to ensure a full 1.5m diameter turning circle is clear.",
        "toilet_seat_height": "Adjust toilet height. If too low, install a seat riser or plinth. If too high, adjust floor or replace unit.",
        "door_width": "Widen the doorway. If structural changes are difficult, consider offset 'swing-clear' hinges to gain width.",
        "grab_bar_obstruction": "Relocate the dispenser, bin, or accessory causing the obstruction away from the grab bar zone.",
        "ToilerPaper_height": "Relocate the toilet paper dispenser to the compliant height range (380mm - 1220mm).",
        "dispenser_height": "Adjust the mounting height of the dispenser so operable parts are between 1120mm and 1220mm.",
        "emergency_button_height": "Relocate the emergency call button to be within 700mm to 1200mm from the floor."
    }
    return recommendations.get(check_key, "Review installation against local accessibility standards and adjust accordingly.")

def run_compliance(
    scene_path: str | Path,
    standards_path: str | Path,
    out_path: str | Path | None = None,
    *,
    include_world_state_debug: bool = True,
) -> Dict[str, Any]:
    scene_path = Path(scene_path)
    standards_path = Path(standards_path)
    out_path = Path(out_path) if out_path is not None else scene_path

    standards_data = _load_json(standards_path)
    standards = standards_data.get("compliance_checks", {})

    world_state = extractor.extract_room_data(str(scene_path))

    compliance_report = []
    for check_key, criteria in standards.items():
        target_obj = criteria.get("target_object")
        metric = criteria.get("metric")
        rules = criteria.get("rules", {})

        description = criteria.get("description", "No description available.")

        obj_data = world_state.get(target_obj) if target_obj else None
        if not obj_data:
            compliance_report.append(
                {
                    "test_id": check_key,
                    "name": criteria.get("name", check_key),
                    "target_object": target_obj,
                    "measured_value": None,
                    "status": "unknown",
                    "message": f"Object '{target_obj}' not found",
                }
            )
            continue

        measured_val = obj_data.get(metric) if metric else None
        status, message = _evaluate_compliance(measured_val, rules)

        report_item = {
            "test_id": check_key,
            "name": criteria.get("name", check_key),
            "target_object": target_obj,
            "measured_value": round(measured_val, 3) if isinstance(measured_val, float) else measured_val,
            "status": status,
            "message": message,
        }

        if status in ["red", "yellow"]:
            report_item["regulations"] = description
            report_item["recommendations"] = _get_recommendation(check_key)

        compliance_report.append(report_item)

    final_json = _load_json(scene_path)
    final_json["compliance_report"] = compliance_report
    if include_world_state_debug:
        final_json["world_state_debug"] = world_state

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(final_json, f, indent=2)

    return final_json


def main() -> None:
    ap = argparse.ArgumentParser(description="Append compliance results into a scene JSON")
    ap.add_argument("--scene", default="scene.json")
    ap.add_argument("--standards", default="standards.json")
    ap.add_argument("--out", default=None, help="If omitted, overwrites --scene")
    ap.add_argument("--no_world_state_debug", action="store_true")
    args = ap.parse_args()

    out = args.out if args.out else args.scene
    run_compliance(
        scene_path=args.scene,
        standards_path=args.standards,
        out_path=out,
        include_world_state_debug=not args.no_world_state_debug,
    )


if __name__ == "__main__":
    main()