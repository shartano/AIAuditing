import os
import tempfile
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any
import json
import time
import urllib.request
import urllib.error

import fastapi
from pydantic import BaseModel, Field

import modal

# -----------------------------
# Modal app + secrets
# -----------------------------
APP_NAME = "crepancy-recon"
SUPABASE_SECRET = modal.Secret.from_name("supabase-creds")
SERVER_SECRET = modal.Secret.from_name("server-secret")

app = modal.App(APP_NAME)

# -----------------------------
# Image definition 
# -----------------------------
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "ca-certificates",
        "git",
        "wget",
        "libgl1",
        "libglib2.0-0",
        "colmap",
    )
    .pip_install(
        "supabase==2.*",
        "opencv-contrib-python-headless",
        "numpy",
        "ultralytics==8.*",
        "fastapi==0.*",
    )
    # Ship pipeline code + weights into the container.
    .add_local_file("best.pt", "/app/best.pt")
    .add_local_file("frame_transform.py", "/app/frame_transform.py")
    .add_local_file("step1_align_floor.py", "/app/step1_align_floor.py")
    .add_local_file("step2_footprint_walls.py", "/app/step2_footprint_walls.py")
    .add_local_file("step3_detect_items.py", "/app/step3_detect_items.py")
    .add_local_file("step4_scale_aruco.py", "/app/step4_scale_aruco.py")
    .add_local_file("preprocessing.py", "/app/preprocessing.py")
    .add_local_file("extractor.py", "/app/extractor.py")
    .add_local_file("compliance_check.py", "/app/compliance_check.py")
    .add_local_file("standards.json", "/app/standards.json")
)

# -----------------------------
# web API for job submission
# -----------------------------
web_app = fastapi.FastAPI()


class SubmitRequest(BaseModel):
    scan_id: str = Field(..., description="Unique scan id / input prefix under audit_input/{scan_id}/...")
    marker_size_m: float = Field(0.096, ge=0.001)
    marker_id: int = Field(22, ge=-1)


@web_app.post("/submit")
def submit(req: SubmitRequest):
    scan_id = (req.scan_id or "").strip().strip("/")
    if not scan_id:
        raise fastapi.HTTPException(status_code=400, detail="scan_id is required")

    # spawn async pipeline job and return immediately
    call = run_full_pipeline_from_supabase.spawn(
        scan_id=scan_id,
        marker_size_m=req.marker_size_m,
        marker_id=req.marker_id,
    )
    return {"scan_id": scan_id, "job_id": call.object_id, "status": "queued"}


@web_app.get("/health")
def health():
    return {"ok": True}


# Expose the FastAPI app via Modal
@app.function(image=image, secrets=[SUPABASE_SECRET, SERVER_SECRET], cpu=1, memory=512)
@modal.asgi_app(label="api", requires_proxy_auth=False)
def api():
    return web_app

# -----------------------------
# Helpers: Supabase
# -----------------------------
def _sb():
    """
    Lazy import so you DON'T need supabase installed locally just to import this file.
    supabase is installed in the Modal image for runtime.
    """
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _upload_file(sb, bucket: str, remote_path: str, local_path: Path) -> None:
    sb.storage.from_(bucket).upload(
        remote_path,
        local_path.read_bytes(),
        file_options={"x-upsert": "true"},
    )


def _download_prefix(sb, bucket: str, prefix: str, dst_dir: Path) -> int:
    """
    Download all files under `prefix` from Supabase Storage into dst_dir,
    preserving subdirectory structure.

    Returns number of files downloaded.
    """
    storage = sb.storage.from_(bucket)
    prefix = prefix.strip("/")

    def _walk(pfx: str) -> int:
        n = 0
        items = storage.list(path=pfx)
        for it in items:
            name = it.get("name")
            if not name:
                continue

            key = f"{pfx}/{name}" if pfx else name

            # If it's a folder, list() should return contents.
            # (Supabase list isn't recursive; we recurse.)
            try:
                sub_items = storage.list(path=key)
            except Exception:
                sub_items = None

            if sub_items:
                n += _walk(key)
                continue

            data = storage.download(key)

            # local_rel: key stripped of prefix root
            if prefix and key.startswith(prefix + "/"):
                rel = key[len(prefix) + 1 :]
            else:
                rel = key

            local_path = dst_dir / rel
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(data)
            n += 1

        return n

    return _walk(prefix)


# -----------------------------
# Helpers: process execution + logging
# -----------------------------
def _log(msg: str) -> None:
    # Modal captures stdout into logs; flush to show progress promptly.
    print(msg, flush=True)


def _stream_process_output(p: subprocess.Popen, log_f) -> None:
    assert p.stdout is not None
    for raw in iter(p.stdout.readline, b""):
        try:
            line = raw.decode("utf-8", errors="replace")
        except Exception:
            line = str(raw)
        log_f.write(line)
        log_f.flush()
        # Mirror into Modal logs
        print(line.rstrip("\n"), flush=True)


def _run(
    cmd: list[str],
    log_f,
    *,
    env: Optional[Dict[str, str]] = None,
    cwd: Optional[Path] = None,
) -> None:
    """
    Run a command, stream stdout/stderr into:
      - log_f (persisted file)
      - Modal logs (stdout)
    Raise on failure.
    """
    header = ">>> " + " ".join(map(str, cmd))
    log_f.write(header + "\n")
    log_f.flush()
    _log(header)

    p = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        cwd=str(cwd) if cwd else None,
        bufsize=1,
    )

    _stream_process_output(p, log_f)

    rc = p.wait()
    if rc != 0:
        log_f.write(f"\nFAILED with code {rc}\n")
        log_f.flush()
        raise RuntimeError(f"Command failed ({rc}): {' '.join(cmd)}")


def _headless_env() -> Dict[str, str]:
    """
    COLMAP on Modal is headless; ensure it doesn't try to use GUI/OpenGL.
    """
    env = os.environ.copy()
    env["QT_QPA_PLATFORM"] = "offscreen"

    runtime_dir = Path("/tmp/runtime-colmap")
    runtime_dir.mkdir(parents=True, exist_ok=True)
    runtime_dir.chmod(0o700)
    env["XDG_RUNTIME_DIR"] = str(runtime_dir)
    return env

# -----------------------------
# server helpers
# -----------------------------
def _send_pipeline_callback(scan_id: str, status: str, summary: Optional[dict] = None) -> None: # summary will be for error logging, not implemented yet
    """
    Best-effort callback to Railway. Should not crash the pipeline if callback fails.
    """
    url = os.environ.get("CALLBACK_URL", "").strip()
#    secret = os.environ.get("CALLBACK_SECRET", "").strip()
    if not url:
        _log("[callback] CALLBACK_URL not set; skipping callback")
        return
#    if not secret:
#        _log("[callback] CALLBACK_SECRET not set; skipping callback")
#        return

    job_id = modal.current_function_call_id() or ""  # Modal call id for this run

    payload = {
        "scan_id": scan_id,
        "job_id": job_id,
        "status": status,  # "completed" or "failed"
    }
    if summary is not None:
        payload["summary"] = summary

    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    try:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    except Exception as e:
        _log(f"[callback] bad CALLBACK_URL={url!r}: {e}")
        return

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            _log(f"[callback] sent status={status} scan_id={scan_id} http={resp.status}")
    except Exception as e:
        _log(f"[callback] failed (non-fatal): {e}")



# -----------------------------
# Diagnostics / smoke tests
# -----------------------------
@app.function(image=image, secrets=[SUPABASE_SECRET], cpu=1, memory=512, timeout=60)
def smoke_test() -> Dict[str, bool]:
    return {
        "SUPABASE_URL": bool(os.environ.get("SUPABASE_URL")),
        "SUPABASE_SERVICE_ROLE_KEY": bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY")),
        "SUPABASE_INPUT_BUCKET": bool(os.environ.get("SUPABASE_INPUT_BUCKET")),
        "SUPABASE_OUTPUT_BUCKET": bool(os.environ.get("SUPABASE_OUTPUT_BUCKET")),
    }


@app.function(image=image, cpu=1, memory=512, timeout=60)
def colmap_smoke_test() -> Dict[str, Any]:
    r = subprocess.run(["colmap", "help"], capture_output=True, text=True)
    return {"returncode": r.returncode, "stdout": r.stdout[:2000], "stderr": r.stderr[:2000]}


# -----------------------------
# Pipeline runner
# -----------------------------
@app.function(
    image=image,
    secrets=[SUPABASE_SECRET, SERVER_SECRET],
    cpu=8,
    memory=8192,
    timeout=60 * 45,
)
def run_full_pipeline_from_supabase(
    scan_id: str,
    marker_size_m: float = 0.096,
    marker_id: int = 22,
) -> Dict[str, Any]:
    sb = _sb()
    in_bucket = os.environ.get("SUPABASE_INPUT_BUCKET", "audit_input")
    out_bucket = os.environ.get("SUPABASE_OUTPUT_BUCKET", "audit_output")

    input_prefix = str(scan_id).strip("/")
    output_prefix = str(scan_id).strip("/")

    env = _headless_env()

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        images_dir = td / "images"
        colmap_dir = td / "colmap"
        sparse_dir = td / "sparse"
        out_dir = td / "out"

        images_dir.mkdir()
        colmap_dir.mkdir()
        sparse_dir.mkdir()
        out_dir.mkdir()

        _log(f"[pipeline] Downloading inputs: {in_bucket}/{input_prefix} -> {images_dir}")
        n = _download_prefix(sb, in_bucket, input_prefix, images_dir)
        if n == 0:
            raise RuntimeError(f"No images found under {in_bucket}/{input_prefix}")
        _log(f"[pipeline] Downloaded {n} files")

        db_path = colmap_dir / "database.db"
        log_path = td / "pipeline_log.txt"

        try:
            with open(log_path, "w", encoding="utf-8") as lf:
                # 0) Preprocessing: verify ArUco marker is present before running anything
                _log("[pipeline] Preprocessing: checking frames for ArUco marker")
                _run(
                    [
                        "python", "/app/preprocessing.py",
                        "--images_dir", str(images_dir),
                        "--aruco_dict", "DICT_4X4_50",
                        "--marker_id", str(marker_id),
                        "--scan_all",
                    ],
                    lf,
                    env=env,
                )

                # 1) COLMAP sparse
                _log("[pipeline] Step 0: COLMAP sparse reconstruction")
                _run(
                    [
                        "colmap", "feature_extractor",
                        "--database_path", str(db_path),
                        "--image_path", str(images_dir),
                        "--ImageReader.single_camera", "1",
                        "--SiftExtraction.use_gpu", "0",
                        "--SiftExtraction.num_threads", "8",
                    ],
                    lf,
                    env=env,
                )

                _run(
                    [
                        "colmap", "sequential_matcher",
                        "--database_path", str(db_path),
                        "--SiftMatching.use_gpu", "0",
                        "--SiftMatching.num_threads", "8",
                    ],
                    lf,
                    env=env,
                )

                _run(
                    [
                        "colmap", "mapper",
                        "--database_path", str(db_path),
                        "--image_path", str(images_dir),
                        "--output_path", str(sparse_dir),
                    ],
                    lf,
                    env=env,
                )

                model0 = sparse_dir / "0"
                if not model0.exists():
                    raise RuntimeError("COLMAP produced no model folder sparse/0")

                # 2) Convert to TXT for your scripts
                _log("[pipeline] Converting COLMAP model to TXT")
                _run(
                    [
                        "colmap", "model_converter",
                        "--input_path", str(model0),
                        "--output_path", str(model0),
                        "--output_type", "TXT",
                    ],
                    lf,
                    env=env,
                )

                points_txt = model0 / "points3D.txt"
                images_txt = model0 / "images.txt"

                # 3) Step1 (align floor)  --- FIX: pass --out_dir explicitly ---
                # Step1 writes floor_alignment.json, points3D_aligned.xyz, step1_diagnostics.json into args.out_dir. :contentReference[oaicite:3]{index=3}
                _log("[pipeline] Step 1: Align floor")
                _run(
                    [
                        "python", "/app/step1_align_floor.py",
                        "--points", str(points_txt),
                        "--images", str(images_txt),
                        "--out_dir", str(out_dir),
                        "--out_xyz", "points3D_aligned.xyz",
                    ],
                    lf,
                    env=env,
                )

                aligned_xyz = out_dir / "points3D_aligned.xyz"
                floor_alignment_json = out_dir / "floor_alignment.json"
                if not aligned_xyz.exists():
                    raise RuntimeError(f"Expected {aligned_xyz} not found after step1")
                if not floor_alignment_json.exists():
                    raise RuntimeError(f"Expected {floor_alignment_json} not found after step1")

                # 4) Step2 (footprint/walls)
                _log("[pipeline] Step 2: Footprint + walls")
                _run(
                    [
                        "python", "/app/step2_footprint_walls.py",
                        "--aligned_xyz", str(aligned_xyz),
                        "--out_dir", str(out_dir),
                        "--write_floor",
                        "--cell_ratio", "0.015",
                        "--simplify_ratio", "0.03",
                    ],
                    lf,
                    env=env,
                )

                scene_json = out_dir / "scene.json"
                if not scene_json.exists():
                    raise RuntimeError(f"Expected {scene_json} not found after step2")

                # 5) Step3 (YOLO detect)
                # Step3 expects: images_dir, colmap_text_dir, scene_json, floor_alignment_json, model. :contentReference[oaicite:4]{index=4}
                _log("[pipeline] Step 3: Detect items (YOLO + COLMAP tracks)")
                _run(
                    [
                        "python", "/app/step3_detect_items.py",
                        "--images_dir", str(images_dir),
                        "--colmap_text_dir", str(model0),
                        "--scene_json", str(scene_json),
                        "--model", "/app/best.pt",
                        "--floor_alignment_json", str(floor_alignment_json),
                        "--write_backup",
                        "--diagnostics_json", str(out_dir / "step3_diagnostics.json"),
                    ],
                    lf,
                    env=env,
                )
                # 6) Step4 (scale aruco) — overwrite scene.json (no separate scaled scene)
                _log("[pipeline] Step 4: Scale to meters (ArUco)")
                scene_tmp = out_dir / "_scene_tmp_scaled.json"
                _run(
                    [
                        "python", "/app/step4_scale_aruco.py",
                        "--colmap_text", str(model0),
                        "--images_dir", str(images_dir),
                        "--scene_in", str(scene_json),
                        "--scene_out", str(scene_tmp),
                        "--marker_size_m", str(marker_size_m),
                        "--marker_id", str(marker_id),
                        "--diag_out", str(out_dir / "step4_diagnostics.json"),
                    ],
                    lf,
                    env=env,
                )

                if not scene_tmp.exists():
                    raise RuntimeError(f"Expected {scene_tmp} not found after step4")

                # Replace scene.json atomically
                scene_tmp.replace(scene_json)

                # 7) Step5: Compliance checks (append into scene.json)
                _log("[pipeline] Step 5: Compliance checks")
                _run(
                    [
                        "python", "/app/compliance_check.py",
                        "--scene", str(scene_json),
                        "--standards", "/app/standards.json",
                        "--out", str(scene_json),
                    ],
                    lf,
                    env=env,
                )


        except Exception:
            # Always upload log on failure
            if log_path.exists():
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)

            # notify server of failure
            _send_pipeline_callback(
                scan_id=scan_id,
                status="failed"
            )
            raise
        # Upload primary outputs
        _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)

        # Upload final scene.json (after scaling + compliance)
        if (out_dir / "scene.json").exists():
            _upload_file(sb, out_bucket, f"{output_prefix}/scene.json", out_dir / "scene.json")

        # Upload diagnostics if present
        for name in [
            "step1_diagnostics.json",
            "floor_alignment.json",
            "points3D_aligned.xyz",
            "step3_diagnostics.json",
            "step4_diagnostics.json",
        ]:
            p = out_dir / name
            if p.exists():
                _upload_file(sb, out_bucket, f"{output_prefix}/{name}", p)

        # Optional: upload COLMAP txt for debugging
        for name in ["cameras.txt", "images.txt", "points3D.txt"]:
            p = (sparse_dir / "0") / name
            if p.exists():
                _upload_file(sb, out_bucket, f"{output_prefix}/colmap_text/{name}", p)

        _log(f"[pipeline] DONE. Uploaded to {out_bucket}/{output_prefix}")

        # send server a callback to notifify job completion
        _send_pipeline_callback(
            scan_id=scan_id,
            status="completed"
        )
        return {"downloaded": n, "output_prefix": output_prefix}


# option local entrypoint for testing
@app.local_entrypoint()
def main(
    scan_id: str = "",
    marker_size_m: float = 0.096,
    marker_id: int = 22,
):
    if not scan_id:
        raise SystemExit(
            "Usage: modal run modal_worker.py --scan-id <SCAN_ID> [--marker-size-m ...] [--marker-id ...]\n"
            "Example: modal run modal_worker.py --scan-id seb1 --marker-size-m 0.096 --marker-id 22"
        )
    run_full_pipeline_from_supabase.remote(
        scan_id=scan_id,
        marker_size_m=marker_size_m,
        marker_id=marker_id,
    )
