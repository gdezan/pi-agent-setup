"""Run after npm install and pi install npm:pi-model-pick. Uses a local, non-network provider."""
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
MODEL_PICK = Path(os.environ.get("PI_MODEL_PICK_EXTENSION", str(
    Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent")))
    / "npm/node_modules/pi-model-pick/extensions/model-pick.ts"
)))


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
        (agent / "keybindings.json").write_text(json.dumps({"app.model.cycleBackward": "alt+p"}))
        self.assertTrue(MODEL_PICK.is_file(), "Install pi-model-pick or set PI_MODEL_PICK_EXTENSION to its extension file")
        picker_state = agent / "model-picker-state.json"
        picker_state.write_text(json.dumps({"favorites": [
            "utility-test/conversation", "missing/model", "utility-test/alternate",
        ], "recents": []}))
        log = base / "requests.jsonl"
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
        env.update({"HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "PI_CODING_AGENT_SESSION_DIR": str(agent / "sessions"),
                    "PI_UTILITY_TEST_LOG": str(log), "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "TERM": "xterm-256color"})
        self.socket = f"utility-{os.getpid()}-{mode}"
        self.env = env
        argv = ["node", str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
                "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
                "--offline", "--no-approve", "--no-session", "--provider", "utility-test", "--model", "conversation", "--thinking", "off"]
        for path in ["tests/fixtures/utility-model-provider.ts", "pi-footer/index.ts", "pi-favorites-cycle/index.ts", "pi-session-autoname/index.ts", "pi-next-prompt/index.ts"]:
            argv += ["-e", str(ROOT / "extensions" / path)]
        argv += ["-e", str(MODEL_PICK)]
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
            self.wait_for(lambda: "alternate (utility-test)" in self.capture(), "favorite shortcut skips unavailable models")
            self.tmux("send-keys", "C-p")
            self.wait_for(lambda: "conversation (utility-test)" in self.capture(), "favorite cycle wraps")
            self.tmux("send-keys", "C-p", "C-p", "C-p")
            self.wait_for(lambda: "alternate (utility-test)" in self.capture(), "rapid favorite cycling is serialized")
            self.tmux("send-keys", "M-p")
            self.wait_for(lambda: "conversation (utility-test)" in self.capture(), "remapped backward favorite cycle")
            self.tmux("send-keys", "C-p")
            self.wait_for(lambda: "alternate (utility-test)" in self.capture(), "forward cycle after backward cycling")
            self.send("/fav")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: "utility-test/alternate" not in json.loads(picker_state.read_text())["favorites"], "unfavorite current model")
            self.tmux("send-keys", "C-p")
            self.wait_for(lambda: "conversation (utility-test)" in self.capture(), "cycle reads changed favorites outside the current model")
            self.send("/fav")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: "utility-test/conversation" not in json.loads(picker_state.read_text())["favorites"], "remove last available favorite")
            self.tmux("send-keys", "C-p")
            self.wait_for(lambda: "No available favorites" in self.capture(), "empty favorites warning")
            self.assertIn("conversation (utility-test)", self.capture())
            self.send("/fav")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: "utility-test/conversation" in json.loads(picker_state.read_text())["favorites"], "restore favorite")
            self.send("/reload")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: "Reloaded" in self.capture(), "reload extensions")
            self.send("/pick")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: "Select Model" in self.capture(), "favorites-first picker after reload")
            self.save_capture(base, "favorites")
            self.send("alternate")
            self.wait_for(lambda: "── Recent ──" in self.capture() and "── Favorites ──" not in self.capture(), "picker search")
            self.save_capture(base, "picker")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: "alternate (utility-test)" in self.capture(), "picker selection")
            self.tmux("send-keys", "C-p")
            self.wait_for(lambda: "conversation (utility-test)" in self.capture(), "cycle resynchronizes after picker selection")
            self.tmux("send-keys", "-l", "\x1b[77;6u")
            self.wait_for(lambda: "Select Model" in self.capture(), "Ctrl+Shift+M picker shortcut")
            self.tmux("send-keys", "Escape")
            self.wait_for(lambda: "Select Model" not in self.capture(), "picker cancel")
            self.send("Show the final suggestion")
            self.tmux("send-keys", "Enter")
            self.wait_for(lambda: SUGGESTION in self.capture(), "suggestion after favorite switching")
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
            try:
                if predicate():
                    return
            except json.JSONDecodeError:
                pass
            time.sleep(0.05)
        self.fail(f"Timed out waiting for {description}\n{self.capture()}")


if __name__ == "__main__":
    unittest.main()
