import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Exec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ code?: number; exitCode?: number; stdout: string; stderr: string }>;

const CAPTURE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$source = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class PiTerminalCapture {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    public static void Capture(string path) {
        RECT rect;
        if (!GetWindowRect(GetForegroundWindow(), out rect)) throw new InvalidOperationException("GetWindowRect failed");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) throw new InvalidOperationException("Foreground window has no size");
        Bitmap bitmap = new Bitmap(width, height);
        Graphics graphics = Graphics.FromImage(bitmap);
        graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, bitmap.Size);
        bitmap.Save(path);
        graphics.Dispose();
        bitmap.Dispose();
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing.dll
[PiTerminalCapture]::Capture(OUTPUT_PATH)
if (!(Test-Path -LiteralPath OUTPUT_PATH)) { throw "Screenshot was not written" }
`;

function quotePowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function exitCode(result: { code?: number; exitCode?: number }): number {
	return result.code ?? result.exitCode ?? 0;
}

async function execChecked(exec: Exec, command: string, args: string[], signal?: AbortSignal) {
	const result = await exec(command, args, { signal, timeout: 15_000 });
	if (exitCode(result) !== 0) {
		throw new Error(`${command} failed: ${result.stderr || result.stdout || `exit ${exitCode(result)}`}`);
	}
	return result;
}

async function captureForegroundTerminal(exec: Exec, signal?: AbortSignal): Promise<string> {
	const temp = await execChecked(exec, "powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"[IO.Path]::GetTempPath()",
	], signal);
	const windowsTemp = temp.stdout.trim().replace(/[\\/]+$/, "");
	if (!windowsTemp) throw new Error("PowerShell did not return a temp directory");

	const windowsPath = `${windowsTemp}\\pi-terminal-${randomUUID()}.png`;
	const localPath = (await execChecked(exec, "wslpath", ["-u", windowsPath], signal)).stdout.trim();
	if (!localPath) throw new Error("wslpath did not return a readable screenshot path");

	try {
		const script = CAPTURE_SCRIPT.replaceAll("OUTPUT_PATH", quotePowerShell(windowsPath));
		await execChecked(exec, "powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		], signal);
		return (await readFile(localPath)).toString("base64");
	} finally {
		await unlink(localPath).catch(() => {});
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "terminal_screenshot",
		label: "Terminal Screenshot",
		description: "Capture the foreground Windows Terminal window and return it as an image for visual inspection.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const data = await captureForegroundTerminal((command, args, options) => pi.exec(command, args, options), signal);
			return {
				content: [
					{ type: "image" as const, data, mimeType: "image/png" },
					{ type: "text" as const, text: "Captured the foreground window as PNG." },
				],
				details: { format: "png", scope: "foreground-window" },
			};
		},
	});
}
