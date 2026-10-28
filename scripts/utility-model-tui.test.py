"""Run with Python 3 and tmux after npm install. Uses a local, non-network provider."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUGGESTION = "Yes, implement the fix"


@unittest.skipUnless(shutil.which("tmux"), "tmux is required for real TUI verification")
class UtilityModelTuiTest(unittest.TestCase):
    def test_suggestions_and_shared_model(self):
        artifacts = Path(tempfile.mkdtemp(prefix="pi-utility-tui-"))
        print(f"TUI captures and fixture request logs: {artifacts}", flush=True)
        for mode, theme in [("fullscreen", "dark"), ("regular", "light")]:
            with self.subTest(mode=mode, theme=theme):
                self.run_workflow(artifacts / mode, mode, theme)

    def run_workflow(self, base, mode, theme):
        base.mkdir()
        agent = base / "agent"
        agent.mkdir()
        home = base / "home"
        home.mkdir()
        project = base / "project"
        project.mkdir()
        settings = agent / "settings.json"
        settings.write_text(json.dumps({
            "sessionAutoname": {"enabled": True, "model": "utility-test/utility", "thinkingLevel": "low"},
            "quietStartup": True, "theme": theme, "tuiMode": mode,
            "enableInstallTelemetry": False, "enableAnalytics": False,
        }))
        (agent / "model-tiers.json").write_text(json.dumps({"roles": [
            {"id": "fast", "label": "Fast", "provider": "utility-test", "model": "conversation", "thinkingLevel": "off"},
            {"id": "daily", "label": "Daily", "provider": "utility-test", "model": "alternate", "thinkingLevel": "off"},
            {"id": "smart", "label": "Smart", "provider": "utility-test", "model": "utility", "thinkingLevel": "low"},
        ]}))
        log = base / "requests.jsonl"
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
        env.update({"HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "PI_CODING_AGENT_SESSION_DIR": str(agent / "sessions"),
                    "PI_UTILITY_TEST_LOG": str(log), "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "TERM": "xterm-256color"})
        self.socket = f"utility-{os.getpid()}-{mode}"
        self.env = env
        argv = ["node", str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
                "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
                "--offline", "--no-approve", "--no-session", "--provider", "utility-test", "--model", "conversation", "--thinking", "off"]
        for path in ["tests/fixtures/utility-model-provider.ts", "pi-footer/index.ts", "model-tiers.ts", "session-autoname.ts", "next-prompt/index.ts"]:
            argv += ["-e", str(ROOT / "dotfiles/extensions" / path)]
        self.tmux("new-session", "-d", "-s", "check", "-x", "100", "-y", "32", "-c", str(project), "exec " + shlex.join(argv))
        self.tmux("set-option", "-g", "extended-keys", "on")
        try:
            self.wait_for(lambda: "conversation (utility-test)" in self.capture(), "Pi editor startup")
            self.send("Please fix the settings bug")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: SUGGESTION in self.capture(), "ghost suggestion")
            self.save_capture(base, "ghost")
            self.assertEqual(len([entry for entry in self.records(log) if entry["kind"] == "conversation" and entry["phase"] == "started"]), 1)
            self.assertTrue(any(entry["kind"] == "naming" and entry["model"] == "utility" for entry in self.records(log)))
            self.tmux("send-keys", "Tab")
            time.sleep(0.15)
            self.save_capture(base, "accepted")
            self.assertEqual(len([entry for entry in self.records(log) if entry["kind"] == "conversation" and entry["phase"] == "started"]), 1, "Tab must not submit")
            self.tmux("send-keys", "C-u")
            self.send("/autoname model utility-test/alternate low")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: "utilityModel" in settings.read_text(), "shared settings migration")
            migrated = json.loads(settings.read_text())
            self.assertEqual(migrated["utilityModel"], {"model": "utility-test/alternate", "thinkingLevel": "low"})
            self.assertEqual(migrated["sessionAutoname"], {"enabled": True})
            self.send("/autoname")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: any(entry["kind"] == "naming" and entry["model"] == "alternate" for entry in self.records(log)), "AutoName using changed utility model")
            self.wait_for(lambda: "naming" in log.read_text() and "Session already named" in self.capture(), "manual naming result")
            self.send("Another request for the same fix")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: len([entry for entry in self.records(log) if entry["kind"] == "suggestion" and entry["phase"] == "started"]) >= 2, "second pending suggestion")
            self.send("manual input")
            self.wait_for(lambda: any(entry["kind"] == "suggestion" and entry["phase"] == "aborted" for entry in self.records(log)), "typing cancels pending request")
            time.sleep(0.9)
            self.save_capture(base, "cancelled")
            self.assertIn("manual input", self.capture())
            self.assertNotIn(SUGGESTION, self.capture())
            self.tmux("send-keys", "C-u", "C-p")
            self.wait_for(lambda: "alternate (utility-test)" in self.capture(), "model-tier shortcut")
            self.send("Show the final suggestion")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: SUGGESTION in self.capture(), "suggestion after tier switching")
            self.tmux("resize-window", "-x", "44", "-y", "26")
            time.sleep(0.2)
            self.save_capture(base, "narrow")
            self.tmux("send-keys", "Escape")
            time.sleep(0.1)
            self.save_capture(base, "dismissed")
            self.assertNotIn(SUGGESTION, self.capture())
            self.send("/next-prompt off")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: json.loads(settings.read_text()).get("nextPrompt", {}).get("enabled") is False, "disable command")
            for entry in self.records(log):
                if entry["kind"] == "suggestion":
                    self.assertIn(entry["model"], ["utility", "alternate"])
                    self.assertEqual(entry["maxTokens"], 512)
                    self.assertEqual(entry["reasoning"], "low")
            self.save_capture(base, "status")
        finally:
            self.save_capture(base, "final")
            self.tmux("kill-server", check=False)

    def tmux(self, *args, check=True):
        return subprocess.run(["tmux", "-L", self.socket, *args], env=self.env, text=True, capture_output=True, check=check).stdout

    def capture(self):
        return self.tmux("capture-pane", "-p", "-t", "check:0.0")

    def save_capture(self, base, name):
        (base / f"{name}.txt").write_text(self.tmux("capture-pane", "-p", "-t", "check:0.0", check=False))
        (base / f"{name}.ansi").write_text(self.tmux("capture-pane", "-p", "-e", "-t", "check:0.0", check=False))

    def send(self, text):
        self.tmux("send-keys", "-l", text)

    @staticmethod
    def records(path):
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def wait_for(self, predicate, description):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail(f"Timed out waiting for {description}\n{self.capture()}")


if __name__ == "__main__":
    unittest.main()
