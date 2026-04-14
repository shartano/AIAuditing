import os
import tempfile
import subprocess
from pathlib import Path

from supabase import create_client
import modal

app = modal.App("crepancy-recon")
SUPABASE_SECRET = modal.Secret.from_name("supabase-creds")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "git",
        "wget",
        "ca-certificates",
        "libgl1",
        "libglib2.0-0",
        "colmap",
    )
    .pip_install(
        "supabase==2.*",
        "opencv-contrib-python-headless",
        "numpy",
    )
)

image = (
    image
    .add_local_file("best.pt", "/best.pt")
    .add_local_file("step1_align_floor.py", "/step1_align_floor.py")
    .add_local_file("step2_footprint_walls.py", "/step2_footprint_walls.py")
    .add_local_file("step3_detect_items.py", "/step3_detect_items.py")
    .add_local_file("step4_scale_aruco.py", "/step4_scale_aruco.py")
)

def _sb():
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

def _upload_file(sb, bucket: str, remote_path: str, local_path: Path):
    sb.storage.from_(bucket).upload(
        remote_path,
        local_path.read_bytes(),
        file_options={"x-upsert": "true"},
    )

def _download_prefix(sb, bucket: str, prefix: str, dst_dir: Path) -> int:
    """
    Downloads all files under `prefix` from Supabase Storage into dst_dir.
    Returns number of files downloaded.
    """
    storage = sb.storage.from_(bucket)

    # Supabase Storage list is not recursive by default; we recurse manually.
    def _walk(pfx: str) -> int:
        n = 0
        # list() returns objects with "name" for files and "id"/metadata; "name" is the key.
        items = storage.list(path=pfx)
        for it in items:
            name = it.get("name")
            if not name:
                continue
            key = f"{pfx}/{name}" if pfx else name

            # Heuristic: if it has a "metadata" with mimetype or an "id", it's a file.
            # If it's a folder, list() will still show it but download will fail; we try recurse.
            # We'll recurse if name has no extension and listing it returns something.
            if "." not in name:
                try:
                    sub_items = storage.list(path=key)
                    if sub_items:
                        n += _walk(key)
                        continue
                except Exception:
                    pass

            # Download file
            data = storage.download(key)
            local_path = dst_dir / name
            local_path.write_bytes(data)
            n += 1
        return n

    return _walk(prefix.strip("/"))

def _run(cmd, log_f, env=None, cwd=None):
    log_f.write(">>> " + " ".join(map(str, cmd)) + "\n")
    log_f.flush()
    p = subprocess.run(cmd, stdout=log_f, stderr=subprocess.STDOUT, env=env, cwd=cwd)
    if p.returncode != 0:
        log_f.write(f"\nFAILED with code {p.returncode}\n")
        log_f.flush()
    return p.returncode

@app.function(image=image, secrets=[SUPABASE_SECRET], cpu=2, memory=2048, timeout=60 * 5)
def smoke_test():
    import os
    keys_present = {
        "SUPABASE_URL": bool(os.environ.get("SUPABASE_URL")),
        "SUPABASE_SERVICE_ROLE_KEY": bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY")),
        "SUPABASE_INPUT_BUCKET": bool(os.environ.get("SUPABASE_INPUT_BUCKET")),
        "SUPABASE_OUTPUT_BUCKET": bool(os.environ.get("SUPABASE_OUTPUT_BUCKET")),
    }
    return keys_present

@app.function(image=image, cpu=2, memory=2048, timeout=60 * 5)
def colmap_smoke_test():
    import subprocess

    r = subprocess.run(
        ["colmap", "help"],
        capture_output=True,
        text=True
    )

    print("RETURN_CODE:", r.returncode)
    print("STDOUT:", r.stdout)
    print("STDERR:", r.stderr)

    return {
        "returncode": r.returncode,
        "stdout": r.stdout.strip(),
        "stderr": r.stderr.strip(),
    }

@app.function(
    image=image,
    secrets=[SUPABASE_SECRET],
    cpu=4,
    memory=8192,
    timeout=60 * 30,
)
def run_sparse_from_supabase(input_prefix: str, output_prefix: str):
    """
    Example:
      input_prefix  = "seb1/images"
      output_prefix = "seb1/outputs/test1"
    """
    sb = _sb()
    in_bucket = os.environ.get("SUPABASE_INPUT_BUCKET", "audit-inputs")
    out_bucket = os.environ.get("SUPABASE_OUTPUT_BUCKET", "audit-outputs")

    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["XDG_RUNTIME_DIR"] = "/tmp"

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        images_dir = td / "images"
        work_dir = td / "colmap"
        model_dir = td / "sparse"
        images_dir.mkdir()
        work_dir.mkdir()
        model_dir.mkdir()

        # 1) download images
        n = _download_prefix(sb, in_bucket, input_prefix, images_dir)
        print(f"Downloaded {n} files from {in_bucket}/{input_prefix} -> {images_dir}")
        if n == 0:
            raise RuntimeError(f"No images found under {in_bucket}/{input_prefix}")

        db_path = work_dir / "database.db"
        log_path = td / "colmap_log.txt"

        # 2) run sparse COLMAP (sequential matcher)
        cmds = [
            ["colmap", "feature_extractor",
             "--database_path", str(db_path),
             "--image_path", str(images_dir),
             "--ImageReader.single_camera", "1",
             "--SiftExtraction.use_gpu", "0",
             "--SiftExtraction.num_threads", "4"],

            ["colmap", "sequential_matcher",
             "--database_path", str(db_path),
             "--SiftMatching.use_gpu", "0",
             "--SiftMatching.num_threads", "4"],

            ["colmap", "mapper",
             "--database_path", str(db_path),
             "--image_path", str(images_dir),
             "--output_path", str(model_dir)],
        ]

        with open(log_path, "w", encoding="utf-8") as lf:
            for cmd in cmds:
                lf.write(">>> " + " ".join(cmd) + "\n")
                lf.flush()
                env = os.environ.copy()
                env["QT_QPA_PLATFORM"] = "offscreen"  # key fix for headless Modal
                p = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, env=env)
                if p.returncode != 0:
                    lf.write(f"\nFAILED with code {p.returncode}\n")
                    lf.flush()
                    # upload log before failing
                    _upload_file(sb, out_bucket, f"{output_prefix}/colmap_log.txt", log_path)
                    raise RuntimeError(f"COLMAP failed at: {' '.join(cmd)}")

        # 3) upload log + a small “proof” artifact (sparse model listing)
        _upload_file(sb, out_bucket, f"{output_prefix}/colmap_log.txt", log_path)

        # Upload the first sparse model folder if it exists (usually model_dir/0)
        model0 = model_dir / "0"
        proof_path = td / "proof.txt"
        if model0.exists():
            files = sorted([p.name for p in model0.iterdir()])
            proof_path.write_text("\n".join(files), encoding="utf-8")
            _upload_file(sb, out_bucket, f"{output_prefix}/proof_sparse_files.txt", proof_path)
            # Optional: upload the binaries too (small-ish for sparse)
            for fn in ["cameras.bin", "images.bin", "points3D.bin"]:
                fp = model0 / fn
                if fp.exists():
                    _upload_file(sb, out_bucket, f"{output_prefix}/{fn}", fp)

        return {"downloaded": n, "output_prefix": output_prefix}
    
@app.function(
    image=image,
    secrets=[SUPABASE_SECRET],
    cpu=4,
    memory=8192,
    timeout=60 * 45,
)
def run_full_pipeline_from_supabase(
    input_prefix: str,           # e.g. "seb1/images"
    output_prefix: str,          # e.g. "seb1/outputs/full1"
    marker_size_m: float = 0.096,
    marker_id: int = 22,
):
    sb = _sb()
    in_bucket = os.environ.get("SUPABASE_INPUT_BUCKET", "audit-inputs")
    out_bucket = os.environ.get("SUPABASE_OUTPUT_BUCKET", "audit-outputs")

    # Headless safety + runtime dir warning fix
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    runtime_dir = Path("/tmp/runtime-colmap")
    runtime_dir.mkdir(parents=True, exist_ok=True)
    runtime_dir.chmod(0o700)
    os.environ["XDG_RUNTIME_DIR"] = str(runtime_dir)

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

        # 1) Download images from Supabase
        n = _download_prefix(sb, in_bucket, input_prefix, images_dir)
        print(f"Downloaded {n} files from {in_bucket}/{input_prefix} -> {images_dir}")
        if n == 0:
            raise RuntimeError(f"No images found under {in_bucket}/{input_prefix}")

        db_path = colmap_dir / "database.db"
        log_path = td / "pipeline_log.txt"

        # Use CPU-only SIFT everywhere (no OpenGL context in Modal)
        colmap_env = os.environ.copy()

        with open(log_path, "w", encoding="utf-8") as lf:
            # 2) COLMAP sparse
            rc = _run(
                [
                    "colmap", "feature_extractor",
                    "--database_path", str(db_path),
                    "--image_path", str(images_dir),
                    "--ImageReader.single_camera", "1",
                    "--SiftExtraction.use_gpu", "0",
                    "--SiftExtraction.num_threads", "4",
                ],
                lf,
                env=colmap_env,
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("COLMAP feature_extractor failed")

            rc = _run(
                [
                    "colmap", "sequential_matcher",
                    "--database_path", str(db_path),
                    "--SiftMatching.use_gpu", "0",
                    "--SiftMatching.num_threads", "4",
                ],
                lf,
                env=colmap_env,
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("COLMAP sequential_matcher failed")

            rc = _run(
                [
                    "colmap", "mapper",
                    "--database_path", str(db_path),
                    "--image_path", str(images_dir),
                    "--output_path", str(sparse_dir),
                ],
                lf,
                env=colmap_env,
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("COLMAP mapper failed")

            model0 = sparse_dir / "0"
            if not model0.exists():
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("COLMAP produced no model folder sparse/0")

            # 3) Convert to TXT (so your scripts can use points3D.txt/images.txt)
            rc = _run(
                [
                    "colmap", "model_converter",
                    "--input_path", str(model0),
                    "--output_path", str(model0),
                    "--output_type", "TXT",
                ],
                lf,
                env=colmap_env,
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("COLMAP model_converter failed")

            points_txt = model0 / "points3D.txt"
            images_txt = model0 / "images.txt"

            # 4) Step1: align floor (run with cwd=out_dir so it writes out/points3D_aligned.xyz)
            rc = _run(
                [
                    "python", "step1_align_floor.py",
                    "--points", str(points_txt),
                    "--images", str(images_txt),
                ],
                lf,
                env=os.environ.copy(),
                cwd=str(out_dir),
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("step1_align_floor failed")

            aligned_xyz = out_dir / "points3D_aligned.xyz"
            if not aligned_xyz.exists():
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("Expected out/points3D_aligned.xyz not found after step1")

            # 5) Step2: footprint/walls (writes to out_dir, incl scene.json if your script does)
            rc = _run(
                [
                    "python", "step2_footprint_walls.py",
                    "--aligned_xyz", str(aligned_xyz),
                    "--out_dir", str(out_dir),
                    "--write_floor",
                    "--cell_ratio", "0.015",
                    "--simplify_ratio", "0.03",
                ],
                lf,
                env=os.environ.copy(),
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("step2_footprint_walls failed")

            scene_json = out_dir / "scene.json"

            # 6) Step3: detect items (YOLO)
            # Assumes best.pt baked into image at /root/best.pt
            rc = _run(
                [
                    "python", "step3_detect_items.py",
                    "--images_dir", str(images_dir),
                    "--colmap_text_dir", str(model0),
                    "--scene_json", str(scene_json),
                    "--model", "/root/best.pt",
                    "--write_backup",
                    "--diagnostics_json", str(out_dir / "step3_diagnostics.json"),
                    "--floor_alignment_json", str(out_dir / "floor_alignment.json"),
                ],
                lf,
                env=os.environ.copy(),
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("step3_detect_items failed")

            # 7) Step4: scale by ArUco (in-place scene update)
            rc = _run(
                [
                    "python", "step4_scale_aruco.py",
                    "--colmap_text", str(model0),
                    "--images_dir", str(images_dir),
                    "--scene_in", str(scene_json),
                    "--scene_out", str(scene_json),
                    "--marker_size_m", str(marker_size_m),
                    "--marker_id", str(marker_id),
                ],
                lf,
                env=os.environ.copy(),
            )
            if rc != 0:
                _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
                raise RuntimeError("step4_scale_aruco failed")

        # 8) Upload key outputs
        _upload_file(sb, out_bucket, f"{output_prefix}/pipeline_log.txt", log_path)
        if scene_json.exists():
            _upload_file(sb, out_bucket, f"{output_prefix}/scene.json", scene_json)

        # Useful diagnostics if present
        for name in ["step3_diagnostics.json", "floor_alignment.json", "points3D_aligned.xyz"]:
            p = out_dir / name
            if p.exists():
                _upload_file(sb, out_bucket, f"{output_prefix}/{name}", p)

        # Optional: upload COLMAP txt for debugging
        for name in ["cameras.txt", "images.txt", "points3D.txt"]:
            p = model0 / name
            if p.exists():
                _upload_file(sb, out_bucket, f"{output_prefix}/colmap_text/{name}", p)

        return {"downloaded": n, "output_prefix": output_prefix}

if __name__ == "__main__":
    # Enables: python modal_worker.py (local entry point), but we typically use `modal run`
    pass