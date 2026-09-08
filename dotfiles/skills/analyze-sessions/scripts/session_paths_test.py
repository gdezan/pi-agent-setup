"""Session discovery respects the selected Pi runtime without reading any logs."""

import os
from pathlib import Path
import subprocess
import sys
import unittest


class SessionPathsTest(unittest.TestCase):
    def session_root(self, **overrides):
        env = {key: value for key, value in os.environ.items()
               if key not in ("PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR")}
        env.update(overrides)
        result = subprocess.run(
            [sys.executable, "-B", "-c", "import sessions; print(sessions.SESSIONS_ROOT)"],
            cwd=Path(__file__).parent, env=env, check=True, capture_output=True, text=True,
        )
        return Path(result.stdout.strip())

    def test_default_uses_home(self):
        self.assertEqual(self.session_root(), Path.home() / ".pi/agent/sessions")

    def test_agent_directory_override(self):
        self.assertEqual(self.session_root(PI_CODING_AGENT_DIR="/tmp/other-agent"),
                         Path("/tmp/other-agent/sessions"))

    def test_session_directory_override_wins(self):
        self.assertEqual(self.session_root(PI_CODING_AGENT_DIR="/tmp/other-agent",
                                          PI_CODING_AGENT_SESSION_DIR="/tmp/other-sessions"),
                         Path("/tmp/other-sessions"))


if __name__ == "__main__":
    unittest.main()
