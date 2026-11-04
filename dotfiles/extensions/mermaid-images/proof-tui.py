"""Exercise a disposable Pi transcript in a pseudo-terminal, without model requests."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent
ARTIFACTS = Path(tempfile.gettempdir()) / "pi-mermaid-images"
EXTENSION = os.environ.get("PI_MERMAID_EXTENSION", str(ROOT / "index.js"))
PACKAGE = os.environ.get("PI_MERMAID_PACKAGE")
CLI = os.environ.get("PI_CLI", shutil.which("pi"))
if not CLI:
    raise SystemExit("Install Pi or set PI_CLI to its executable path")


def run(mode, fixture):
    agent = ARTIFACTS / f"agent-{mode}"
    agent.mkdir(exist_ok=True)
    (agent / "settings.json").write_text(json.dumps({
        "quietStartup": True, "enableInstallTelemetry": False, "enableAnalytics": False,
        "markdown": {"mermaid": "off"}, "tuiMode": mode,
        "theme": os.environ.get("PI_MERMAID_THEME", "dark"),
        "packages": [{"source": PACKAGE, "extensions": ["dotfiles/extensions/mermaid-images/index.js"]}] if PACKAGE else [],
    }))
    env = {key: value for key, value in os.environ.items() if not key.startswith(("HERDR_", "PI_CURSOR_"))}
    env.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", PI_TELEMETRY="0",
               TERM="xterm-256color", TERM_PROGRAM="ghostty")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 100, 1000, 1200))
    process = subprocess.Popen([
        CLI, "--offline", "--no-approve", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--no-themes", "--no-mcp",
        *([] if PACKAGE else ["--no-extensions", "-e", EXTENSION]),
        "--session", str(ARTIFACTS / f"session-{fixture}.jsonl"),
    ], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    data = bytearray()
    resize_offsets = []
    restored_at = None
    deadline = time.monotonic() + 25
    expected_diagrams = 2 if fixture == "multiple" else 1
    try:
        while time.monotonic() < deadline and process.poll() is None:
            if not select.select([master], [], [], 0.2)[0]:
                if restored_at and time.monotonic() - restored_at > 2:
                    break
                continue
            try:
                chunk = os.read(master, 1 << 20)
            except OSError:
                break
            data.extend(chunk)
            for query, reply in [(b"\x1b[16t", b"\x1b[6;20;10t"),
                                 (b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?62;4;6;22c")]:
                if query in chunk:
                    os.write(master, reply)
            if b"a=T" in data and data.count(b"After the diagram.") >= expected_diagrams and not resize_offsets:
                resize_offsets.append(len(data))
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 52, 520, 1200))
                os.kill(process.pid, signal.SIGWINCH)
            elif len(resize_offsets) == 1 and b"a=T" in data[resize_offsets[0]:] and data[resize_offsets[0]:].count(b"After the diagram.") >= expected_diagrams:
                resize_offsets.append(len(data))
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 100, 1000, 1200))
                os.kill(process.pid, signal.SIGWINCH)
                restored_at = time.monotonic()
    finally:
        process.terminate()
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
    capture = ARTIFACTS / f"pi-{fixture}-{mode}.ansi"
    capture.write_bytes(data)
    headers = [value.decode() for value in re.findall(rb"\x1b_G([^;\x1b]*);?", data)]
    placements = [header for header in headers if "a=T" in header or "a=p" in header]
    images = []
    payload = b""
    image_header = None
    for controls, chunk in re.findall(rb"\x1b_G([^;\x1b]*);([A-Za-z0-9+/=]*)\x1b\\", data):
        if b"a=T" in controls:
            image_header, payload = controls.decode(), b""
        if image_header is None:
            continue
        payload += chunk
        if b"m=1" not in controls:
            png = base64.b64decode(payload)
            assert png.startswith(b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack("!II", png[16:24])
            images.append({"header": image_header, "width": width, "height": height})
            image_header = None
    result = {"mode": mode, "fixture": fixture, "capture": str(capture), "placements": placements, "images": images}
    assert len(resize_offsets) == 2, result
    assert len(images) >= 2, result
    assert images[0]["width"] > images[0]["height"], result
    if fixture != "sequence":
        assert any(image["height"] > image["width"] for image in images), result
    assert not any(re.search(r"(?:^|,)r=", header) for header in placements), result
    wide_columns = re.search(r"(?:^|,)(c=\d+)", images[0]["header"]).group(1)
    restored_headers = re.findall(rb"\x1b_G([^;\x1b]*);?", data[resize_offsets[1]:])
    assert any(wide_columns in header.decode().split(",") for header in restored_headers), result
    assert b"Before the diagram." in data and b"After the diagram." in data, result
    assert b"```mermaid" not in data, result
    messages = [json.loads(line) for line in (ARTIFACTS / f"session-{fixture}.jsonl").read_text().splitlines()]
    assert any("```mermaid" in str(entry.get("message", {}).get("content", "")) for entry in messages)
    return result


results = [run(mode, fixture) for fixture in ["linear", "branching", "sequence", "multiple"]
           for mode in ["regular", "fullscreen"]]
(ARTIFACTS / "pty-result.json").write_text(json.dumps(results, indent=2))
print(json.dumps({"result": "PASS", "evidence": results}, indent=2))
