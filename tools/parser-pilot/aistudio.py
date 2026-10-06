"""AI Studio pilot: explicit submit, durable job ID, resumable result collection."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit

JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
MODEL = "PaddleOCR-VL-1.6"
OPTIONS = {"useDocOrientationClassify": False, "useDocUnwarping": False,
           "useChartRecognition": False}


def write_state(out, state):
    temporary = out / "run.json.tmp"
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, out / "run.json")


def read_state(out):
    return json.loads((out / "run.json").read_text(encoding="utf-8"))


def result_url(url):
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or parsed.port not in (None, 443)
            or not (host.endswith(".bcebos.com") or host == "paddleocr.aistudio-app.com")):
        raise ValueError("Result must use a Baidu HTTPS resource host")
    return url


def json_response(response):
    try:
        if response.status_code != 200:
            raise RuntimeError(f"HTTP status {response.status_code}")
        return response.json()["data"]
    finally:
        response.close()


def submit(content, filename, pages, out, token, http):
    if not token:
        raise ValueError("PADDLEOCR_ACCESS_TOKEN is required")
    if not 1 <= pages <= 49 or len(content) > 50 * 1024 * 1024:
        raise ValueError("Pilot limited to 49 pages and 50 MiB per file")
    out.mkdir(parents=True, exist_ok=False)
    state = {"state": "submitting", "pdfSha256": hashlib.sha256(content).hexdigest(),
             "filename": filename, "pages": pages, "model": MODEL, "options": OPTIONS,
             "submittedAt": time.time(), "actualServerModelVersion": "unknown"}
    write_state(out, state)
    try:
        data = json_response(http.post(JOB_URL, headers={"Authorization": f"bearer {token}"},
            data={"model": MODEL, "optionalPayload": json.dumps(OPTIONS)},
            files={"file": (filename, content, "application/pdf")},
            timeout=(30, 120), allow_redirects=False))
        job = data["jobId"]
        if not isinstance(job, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", job):
            raise ValueError("Invalid job ID")
    except Exception as error:
        state.update(state="submit-unknown", failureType=type(error).__name__)
        write_state(out, state)
        raise
    state.update(state="accepted", jobId=job)
    write_state(out, state)
    return state


def collect(out, token, http, poll_seconds=5, wait_seconds=900):
    lock = out / "collect.lock"
    with lock.open("x", encoding="utf-8"):
        pass
    try:
        return _collect(out, token, http, poll_seconds, wait_seconds)
    finally:
        lock.unlink()


def _collect(out, token, http, poll_seconds, wait_seconds):
    state = read_state(out)
    job = state.get("jobId")
    if not isinstance(job, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", job):
        raise ValueError("No accepted job ID; do not automatically re-submit")
    if not token:
        raise ValueError("PADDLEOCR_ACCESS_TOKEN is required")
    if state["state"] == "downloaded":
        if hashlib.sha256((out / "result.jsonl").read_bytes()).hexdigest() != state["rawSha256"]:
            raise ValueError("Saved result digest mismatch")
        return state
    started = time.monotonic()
    while time.monotonic() - started < wait_seconds:
        try:
            data = json_response(http.get(f"{JOB_URL}/{job}",
                headers={"Authorization": f"bearer {token}"}, timeout=(30, 60), allow_redirects=False))
            remote = data["state"]
            state.pop("failureType", None)
            state.update(state="querying", remoteState=remote,
                         progress=data.get("extractProgress"), lastQueryAt=time.time())
            write_state(out, state)
            print(f"Remote state: {remote}", flush=True)
            if remote == "failed":
                state.update(state="remote-failed")
                write_state(out, state)
                raise RuntimeError("Remote job failed; inspect vendor dashboard")
            if remote == "done":
                if data["extractProgress"]["extractedPages"] != state["pages"]:
                    raise ValueError("Extracted page count differs from original PDF")
                url = result_url(data["resultUrl"]["jsonUrl"])
                state.update(state="retrieving", completedAt=time.time())
                write_state(out, state)
                response = http.get(url, stream=True, timeout=(30, 120), allow_redirects=False)
                try:
                    if response.status_code != 200:
                        raise RuntimeError(f"Result HTTP status {response.status_code}")
                    total = 0
                    with (out / "result.jsonl.part").open("wb") as stream:
                        for chunk in response.iter_content(chunk_size=65536):
                            total += len(chunk)
                            if total > 256 * 1024 * 1024:
                                raise ValueError("Result exceeds pilot size limit")
                            stream.write(chunk)
                        stream.flush()
                        os.fsync(stream.fileno())
                finally:
                    response.close()
                partial = out / "result.jsonl.part"
                if not partial.stat().st_size:
                    raise ValueError("Empty JSONL result")
                # Validate syntax before publishing; geometry and page identity are checked separately.
                for line in partial.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        json.loads(line)["result"]
                os.replace(partial, out / "result.jsonl")
                state.update(state="downloaded", downloadedAt=time.time(),
                    elapsedSeconds=time.time() - state["submittedAt"],
                    rawSha256=hashlib.sha256((out / "result.jsonl").read_bytes()).hexdigest())
                write_state(out, state)
                return state
            if remote not in ("pending", "running"):
                raise ValueError("Unexpected remote state")
        except Exception as error:
            state["failureType"] = type(error).__name__
            write_state(out, state)
            raise
        time.sleep(poll_seconds)
    state.update(state="poll-timeout")
    write_state(out, state)
    raise TimeoutError("Polling timed out; resume queries with the saved job ID")


def main():
    import requests
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("submit", "collect"))
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    token = os.environ.get("PADDLEOCR_ACCESS_TOKEN", "")
    with requests.Session() as http:
        if args.command == "submit":
            import pypdfium2 as pdfium
            if args.pdf is None:
                parser.error("submit requires --pdf")
            content = args.pdf.read_bytes()
            with pdfium.PdfDocument(content) as document:
                pages = len(document)
            submit(content, args.pdf.name, pages, args.out.resolve(), token, http)
            print("Job ID saved; use collect to retrieve this task", flush=True)
        else:
            collect(args.out.resolve(), token, http)
            print("Raw JSONL saved; quality and coordinates still require inspection", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid echoing request objects, tokens, or signed resource URLs.
        print(f"Pilot stopped: {type(error).__name__}", flush=True)
        raise SystemExit(1)
