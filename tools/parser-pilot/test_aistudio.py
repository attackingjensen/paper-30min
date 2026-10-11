import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("aistudio", Path(__file__).with_name("aistudio.py"))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class Reply:
    status_code = 200

    def __init__(self, payload=None, content=b""):
        self.payload = payload
        self.content = content

    def json(self):
        return self.payload

    def iter_content(self, chunk_size):
        yield self.content

    def close(self):
        pass


class Http:
    def __init__(self, out, fail_submit=False):
        self.out = out
        self.posts = 0
        self.fail_submit = fail_submit
        self.download_headers = None

    def post(self, url, **kwargs):
        self.posts += 1
        assert api.read_state(self.out)["state"] == "submitting"
        if self.fail_submit:
            raise ConnectionError("unknown acceptance")
        return Reply({"data": {"jobId": "job-123"}})

    def get(self, url, **kwargs):
        assert api.read_state(self.out)["jobId"] == "job-123"
        if url == api.JOB_URL + "/job-123":
            return Reply({"data": {"state": "done", "extractProgress": {"extractedPages": 1},
                "resultUrl": {"jsonUrl": "https://result.bcebos.com/result.jsonl"}}})
        self.download_headers = kwargs.get("headers")
        return Reply(content=b'{"result":{"layoutParsingResults":[]}}\n')


class TaskTests(unittest.TestCase):
    def test_failed_download_is_not_published_and_can_resume(self):
        class InterruptedReply(Reply):
            def iter_content(self, chunk_size):
                yield b'{"result":'
                raise ConnectionError("download interrupted")

        for broken in (Reply(content=b'{"result":'), InterruptedReply()):
            with self.subTest(reply=type(broken).__name__), tempfile.TemporaryDirectory() as directory:
                out = Path(directory) / "run"
                http = Http(out)
                api.submit(b"pdf", "paper.pdf", 1, out, "token", http)
                original_get = http.get

                def get(url, **kwargs):
                    if url == api.JOB_URL + "/job-123":
                        return original_get(url, **kwargs)
                    return broken

                http.get = get
                with self.assertRaises((json.JSONDecodeError, ConnectionError)):
                    api.collect(out, "token", http, poll_seconds=0)
                state = api.read_state(out)
                self.assertNotEqual(state["state"], "downloaded")
                self.assertEqual(state["jobId"], "job-123")
                self.assertFalse((out / "result.jsonl").exists())
                self.assertFalse((out / "collect.lock").exists())
                http.get = original_get
                api.collect(out, "token", http, poll_seconds=0)
                self.assertEqual(api.read_state(out)["state"], "downloaded")
                self.assertEqual(http.posts, 1)

    def test_durable_submit_then_resume_without_reupload_or_credentials_on_download(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "run"
            http = Http(out)
            api.submit(b"pdf", "paper.pdf", 1, out, "test-secret", http)
            self.assertEqual(api.read_state(out)["jobId"], "job-123")
            api.collect(out, "test-secret", http, poll_seconds=0)
            self.assertEqual(http.posts, 1)
            self.assertIsNone(http.download_headers)
            state = api.read_state(out)
            self.assertEqual(state["state"], "downloaded")
            self.assertNotIn("test-secret", (out / "run.json").read_text())
            self.assertTrue((out / "result.jsonl").is_file())
            with self.assertRaises(FileExistsError):
                api.submit(b"pdf", "paper.pdf", 1, out, "test-secret", http)
            self.assertEqual(http.posts, 1)

    def test_ambiguous_submit_is_durable_and_not_resubmitted(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "run"
            http = Http(out, fail_submit=True)
            with self.assertRaises(ConnectionError):
                api.submit(b"pdf", "paper.pdf", 1, out, "token", http)
            self.assertEqual(api.read_state(out)["state"], "submit-unknown")
            with self.assertRaises(ValueError):
                api.collect(out, "token", http, poll_seconds=0)
            self.assertEqual(http.posts, 1)

    def test_page_mismatch_cannot_be_downloaded_success(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "run"
            http = Http(out)
            api.submit(b"pdf", "paper.pdf", 2, out, "token", http)
            with self.assertRaises(ValueError):
                api.collect(out, "token", http, poll_seconds=0)
            self.assertNotEqual(api.read_state(out)["state"], "downloaded")

    def test_result_url_rejects_local_and_non_baidu_hosts(self):
        for url in ("http://result.bcebos.com/x", "https://127.0.0.1/x",
                    "https://bcebos.com.attacker.com/x", "https://user:pass@result.bcebos.com/x"):
            with self.assertRaises(ValueError):
                api.result_url(url)

    def test_active_collection_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "run"
            http = Http(out)
            api.submit(b"pdf", "paper.pdf", 1, out, "token", http)
            (out / "collect.lock").write_text("active", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                api.collect(out, "token", http, poll_seconds=0)
            self.assertEqual((out / "collect.lock").read_text(), "active")

    def test_query_failure_and_timeout_resume_existing_job(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "run"
            http = Http(out)
            api.submit(b"pdf", "paper.pdf", 1, out, "token", http)
            with self.assertRaises(TimeoutError):
                api.collect(out, "token", http, wait_seconds=0)
            original_get = http.get
            http.get = lambda *args, **kwargs: (_ for _ in ()).throw(ConnectionError("offline"))
            with self.assertRaises(ConnectionError):
                api.collect(out, "token", http, poll_seconds=0)
            self.assertEqual(api.read_state(out)["jobId"], "job-123")
            self.assertFalse((out / "collect.lock").exists())
            http.get = original_get
            api.collect(out, "token", http, poll_seconds=0)
            self.assertEqual(http.posts, 1)
            self.assertNotIn("failureType", api.read_state(out))


if __name__ == "__main__":
    unittest.main()
