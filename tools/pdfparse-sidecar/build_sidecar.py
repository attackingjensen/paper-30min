# -*- coding: utf-8 -*-
"""组装 Docling Windows 侧车（Issue #57，规格 #48 §实施决策 1–3）。

产物目录（默认 app/src-tauri/sidecar/pdfparse/，随 Tauri resources 打包）：

    python/     嵌入式 Python 3.11.9（python.org 官方 embed 包，SHA256 钉版校验）
    app/        pdfparse_sidecar.py + requirements-sidecar.txt + 许可声明 + get-pip.py
    models/     模型工件（bundled 案预置；download 案留空，运行时由 bootstrap 填充）
    sidecar-manifest.json

两案（#48 §侧车与打包 2–3）：
    bundled（默认）：python + 全量钉版依赖 + 模型，安装包增量约 +0.8–1.0GB，离线可用。
    download        ：python + app + get-pip.py（约 50MB），首启由 pdfparse.bootstrap@1
                      在线安装依赖与模型（HF_ENDPOINT 可配，内置 hf-mirror 回退）。

用法：
    python tools/pdfparse-sidecar/build_sidecar.py [--variant bundled|download]
        [--output DIR] [--wheels-dir DIR] [--hf-endpoint URL] [--force]

`--wheels-dir` 指向预先 `pip download` 的 wheel 缓存时离线安装（构建机复现用）。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

PYTHON_VERSION = "3.11.9"
PYTHON_EMBED_URL = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
)
# SHA256 钉版；与 python.org 发布页 MD5（6d9aa08531d48fcc261ba667e2df17c4）互证。
PYTHON_EMBED_SHA256 = "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT = REPO_ROOT / "app" / "src-tauri" / "sidecar" / "pdfparse"

# 精简规则（#48 决策 2：精简 site-packages）：只删可再生/运行期不用的内容。
PRUNE_DIR_NAMES = {"__pycache__", "tests", "test"}
PRUNE_SUFFIXES = {".pyc", ".pyo", ".chm"}
# torch 的头文件与 cmake 文件只在编译扩展时需要，运行期不读。
PRUNE_TORCH_DIRS = ["include", "share"]

APP_FILES = ["pdfparse_sidecar.py", "requirements-sidecar.txt", "THIRD_PARTY_NOTICES.md"]


def log(step, message):
    print(f"[build {step}] {message}", flush=True)


def download(url, dest, sha256=None):
    dest = Path(dest)
    if dest.exists():
        if sha256 and hashlib.sha256(dest.read_bytes()).hexdigest() == sha256:
            log("download", f"已存在且校验通过，跳过: {dest.name}")
            return dest
        dest.unlink()
    log("download", f"{url} -> {dest}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as response, open(tmp, "wb") as out:
        shutil.copyfileobj(response, out)
    if sha256:
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if digest != sha256:
            tmp.unlink()
            raise SystemExit(f"SHA256 校验失败: {url} 得到 {digest}，期望 {sha256}")
    tmp.replace(dest)
    return dest


def dir_bytes(path):
    return sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())


def install_embedded_python(work_dir, python_dir):
    if (python_dir / "python.exe").exists():
        log("python", f"已存在: {python_dir}")
        return
    zip_path = download(
        PYTHON_EMBED_URL,
        Path(work_dir) / f"python-{PYTHON_VERSION}-embed-amd64.zip",
        sha256=PYTHON_EMBED_SHA256,
    )
    log("python", f"解包到 {python_dir}")
    python_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(python_dir)
    # 嵌入版默认禁用 site：只用 ._pth 把 Lib\site-packages 加进 sys.path。
    # 刻意不 `import site`——site.py 会启用用户级 site-packages（%APPDATA%\Python），
    # 把宿主机的全局包混进侧车（实测构建日志出现宿主 ipykernel 依赖告警）。
    pth = python_dir / f"python{PYTHON_VERSION.split('.')[0]}{PYTHON_VERSION.split('.')[1]}._pth"
    pth.write_text(
        "python311.zip\n.\nLib\\site-packages\n",
        encoding="utf-8",
    )
    log("python", f"已挂接 site-packages（隔离用户级 site）: {pth.name}")


def copy_app(output):
    app_dir = Path(output) / "app"
    app_dir.mkdir(parents=True, exist_ok=True)
    for name in APP_FILES:
        shutil.copy2(SOURCE_DIR / name, app_dir / name)
    log("app", f"侧车程序与许可声明已就位: {app_dir}")


def ensure_get_pip(work_dir, output):
    get_pip = download(GET_PIP_URL, Path(work_dir) / "get-pip.py")
    shutil.copy2(get_pip, Path(output) / "app" / "get-pip.py")
    return get_pip


def install_python_deps(output, python_dir, wheels_dir=None):
    site_packages = python_dir / "Lib" / "site-packages"
    marker = site_packages / "docling"
    if marker.exists():
        log("deps", "依赖已安装，跳过（--force 重装）")
        return
    python_exe = python_dir / "python.exe"
    requirements = Path(output) / "app" / "requirements-sidecar.txt"
    get_pip = Path(output) / "app" / "get-pip.py"
    log("deps", "引导 pip（嵌入版不含 pip）")
    subprocess.run([str(python_exe), str(get_pip), "--no-warn-script-location"], check=True)
    command = [
        str(python_exe),
        "-m",
        "pip",
        "install",
        "--no-warn-script-location",
        "--no-cache-dir",
    ]
    if wheels_dir:
        command += ["--no-index", "--find-links", str(wheels_dir)]
        log("deps", f"离线安装自 wheel 缓存: {wheels_dir}")
    else:
        log("deps", "在线安装 PyPI 钉版依赖（约 320MB 下载，耗时数分钟）")
    command += ["-r", str(requirements)]
    subprocess.run(command, check=True)


def prune(python_dir):
    site_packages = python_dir / "Lib" / "site-packages"
    removed = 0
    for path in sorted(site_packages.rglob("*")):
        if not path.exists():
            continue  # 父目录刚被删除
        if path.is_dir() and path.name in PRUNE_DIR_NAMES:
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
        elif path.is_file() and path.suffix.lower() in PRUNE_SUFFIXES:
            path.unlink()
            removed += 1
    for name in PRUNE_TORCH_DIRS:
        target = site_packages / "torch" / name
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
            removed += 1
    log("prune", f"已清理 {removed} 处（__pycache__/tests/*.pyc/torch include+share）")


def prefetch_models(output, python_dir, hf_endpoint=None):
    models_dir = Path(output) / "models"
    marker = models_dir / "docling-project--docling-layout-heron" / "model.safetensors"
    if marker.exists():
        log("models", "模型已就位，跳过")
        return
    env = dict(os.environ)
    if hf_endpoint:
        env["HF_ENDPOINT"] = hf_endpoint
    command = [
        str(python_dir / "python.exe"),
        str(Path(output) / "app" / "pdfparse_sidecar.py"),
        "--models-dir",
        str(models_dir),
        "prefetch-models",
        "--out-dir",
        str(output),
    ]
    log("models", "下载模型工件（布局 + TableFormer + RapidOCR，约 0.6GB）")
    process = subprocess.run(command, env=env)
    if process.returncode != 0:
        raise SystemExit("模型下载失败（子进程异常退出）")
    result = json.loads((Path(output) / "result.json").read_text(encoding="utf-8"))
    if not result.get("ok"):
        raise SystemExit(f"模型下载失败: {result['error']}")
    (Path(output) / "result.json").unlink()


def write_manifest(output, variant):
    manifest = {
        "variant": variant,
        "pythonVersion": PYTHON_VERSION,
        "doclingVersion": "2.126.0",
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bytes": dir_bytes(output),
    }
    (Path(output) / "sidecar-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=["bundled", "download"], default="bundled")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--wheels-dir", default=None, help="离线 wheel 缓存目录（可选）")
    parser.add_argument("--hf-endpoint", default=None, help="模型下载端点（默认官方源）")
    parser.add_argument("--force", action="store_true", help="清空产物目录重建")
    args = parser.parse_args()

    output = Path(args.output)
    if args.force and output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    # 构建缓存放产物目录的同级：产物目录整体进安装包（tauri resources），
    # 缓存目录（embed zip、get-pip.py）绝不能被一起打包。
    work_dir = output.parent / ".pdfparse-build-cache"
    work_dir.mkdir(exist_ok=True)

    python_dir = output / "python"
    install_embedded_python(work_dir, python_dir)
    copy_app(output)
    ensure_get_pip(work_dir, output)

    if args.variant == "bundled":
        install_python_deps(output, python_dir, wheels_dir=args.wheels_dir)
        prefetch_models(output, python_dir, hf_endpoint=args.hf_endpoint)
        # prune 放在最后：prefetch 运行 python 会重新生成 __pycache__。
        prune(python_dir)
        # 依赖完整性标记：与 bootstrap 成功路径一致（见 pdfparse.rs deps_ready）。
        (output / "deps.ok").write_text(
            f"built {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n", encoding="utf-8"
        )
    else:
        log("variant", "download 案：不预装依赖与模型，运行时由 pdfparse.bootstrap@1 补齐")

    manifest = write_manifest(output, args.variant)
    log(
        "done",
        f"variant={args.variant} 落盘 {manifest['bytes'] / 1024 / 1024:.0f}MB -> {output}",
    )


if __name__ == "__main__":
    main()
