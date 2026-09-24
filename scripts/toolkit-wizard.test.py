"""Exercise the real Clack wizard in isolated Unix pseudo-terminals."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


class WizardTerminal:
    def __init__(self, home, target, *args, columns=100):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, columns, 0, 0))
        env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "TERM": "xterm-256color", "NO_COLOR": "1"}
        env.pop("CI", None)
        env.pop("FORCE_COLOR", None)
        self.process = subprocess.Popen([shutil.which("node"), str(ROOT / "setup.mjs"), "--agent-dir", str(target), "--no-color", *args],
                                        stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        self.raw = b""
        self.cursor = 0

    def read(self, timeout=0.1):
        if select.select([self.master], [], [], timeout)[0]:
            try:
                self.raw += os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

    def wait_for(self, text):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            self.read()
            current = ANSI.sub(b"", self.raw).decode(errors="replace")
            index = current.find(text, self.cursor)
            if index >= 0:
                self.cursor = index + len(text)
                return
            if self.process.poll() is not None:
                break
        raise AssertionError(f"Missing terminal text: {text!r}\n{ANSI.sub(b'', self.raw).decode(errors='replace')}")

    def send(self, keys):
        os.write(self.master, keys)

    def finish(self):
        deadline = time.monotonic() + 20
        while self.process.poll() is None and time.monotonic() < deadline:
            self.read()
        if self.process.poll() is None:
            raise AssertionError("Wizard did not exit")
        self.read(0)
        return self.process.returncode

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        os.close(self.master)


class WizardTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="pi-wizard-pty-")
        self.addCleanup(self.scratch.cleanup)
        self.home = Path(self.scratch.name) / "home"
        self.home.mkdir()
        self.target = Path(self.scratch.name) / "agent"

    def terminal(self, *args, **kwargs):
        terminal = WizardTerminal(self.home, self.target, *args, **kwargs)
        self.addCleanup(terminal.close)
        return terminal

    def test_install_then_noop_with_one_checklist(self):
        terminal = self.terminal()
        terminal.wait_for("Choose packages;")
        terminal.send(b"\r")
        terminal.wait_for("Apply these changes?")
        terminal.send(b"\r")
        terminal.wait_for("Pi setup complete.")
        self.assertEqual(terminal.finish(), 0)
        self.assertEqual(json.loads((self.target / "toolkit-state.json").read_text())["selectedPackages"], [])
        before = (self.target / "settings.json").stat().st_mtime_ns
        rerun = self.terminal()
        rerun.wait_for("Choose packages;")
        rerun.send(b"\r")
        rerun.wait_for("Everything is already set up.")
        self.assertEqual(rerun.finish(), 0)
        self.assertEqual((self.target / "settings.json").stat().st_mtime_ns, before)
        self.assertNotIn(b"Apply these changes?", rerun.raw)
        self.assertIsNone(re.search(rb"\x1b\[[0-9;]*m", rerun.raw))

    def test_ctrl_c_before_apply_creates_no_destination(self):
        terminal = self.terminal(columns=48)
        terminal.wait_for("Choose packages;")
        terminal.send(b"\x03")
        terminal.wait_for("No changes made.")
        self.assertEqual(terminal.finish(), 130)
        self.assertFalse(self.target.exists())

    def test_back_returns_to_selection_without_writing(self):
        terminal = self.terminal()
        terminal.wait_for("Choose packages;")
        terminal.send(b"\r")
        terminal.wait_for("Apply these changes?")
        terminal.send(b"\x1b[B\r")
        terminal.wait_for("Choose packages;")
        terminal.send(b"\x03")
        self.assertEqual(terminal.finish(), 130)
        self.assertFalse(self.target.exists())

    def test_view_diff_then_keep_local_instructions(self):
        self.target.mkdir()
        instructions = self.target / "APPEND_SYSTEM.md"
        instructions.write_text("MACHINE NOTES\n")
        terminal = self.terminal("--skip-packages")
        terminal.wait_for("How should setup handle this?")
        terminal.send(b"\x1b[B\r")
        terminal.wait_for("Differences")
        terminal.wait_for("How should setup handle this?")
        terminal.send(b"\r")
        terminal.wait_for("Apply these changes?")
        terminal.send(b"\r")
        self.assertEqual(terminal.finish(), 0)
        self.assertEqual(instructions.read_text(), "MACHINE NOTES\n")
        self.assertIn(b"MACHINE NOTES", terminal.raw)
        self.assertFalse((self.target / "toolkit-setup.lock").exists())

    def test_delete_checklist_is_unchecked_and_removes_only_an_explicit_choice(self):
        extra = self.target / "extensions" / "extra.ts"
        extra.parent.mkdir(parents=True)
        extra.write_text("export default function extra() {}\n")
        first = self.terminal("--skip-packages")
        first.wait_for("Delete which unselected packages or unmanaged resources?")
        first.send(b"\r")
        first.wait_for("Apply these changes?")
        first.send(b"\r")
        self.assertEqual(first.finish(), 0)
        self.assertTrue(extra.exists())

        second = self.terminal("--skip-packages")
        second.wait_for("Delete which unselected packages or unmanaged resources?")
        second.send(b" \r")
        second.wait_for("Apply these changes?")
        second.send(b"\r")
        self.assertEqual(second.finish(), 0)
        self.assertFalse(extra.exists())


if __name__ == "__main__":
    unittest.main()
