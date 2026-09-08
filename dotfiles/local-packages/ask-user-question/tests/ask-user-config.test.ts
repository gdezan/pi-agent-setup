import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const override of [false, true]) {
	test(`ask-user configuration uses ${override ? "the selected agent directory" : "the default agent directory"}`, (t) => {
		const home = mkdtempSync(join(tmpdir(), "ask-user-config-"));
		t.after(() => rmSync(home, { recursive: true, force: true }));
		const defaultAgent = join(home, ".pi", "agent");
		const selectedAgent = join(home, "selected-agent");
		for (const [path, promptSnippet] of [[defaultAgent, "default"], [selectedAgent, "selected"]]) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "ask-user-question.json"), JSON.stringify({ promptSnippet }));
		}
		const env = { ...process.env, HOME: home, USERPROFILE: home };
		delete env.PI_CODING_AGENT_DIR;
		if (override) env.PI_CODING_AGENT_DIR = selectedAgent;
		const moduleUrl = new URL("../ask-user-config.ts", import.meta.url).href;
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
			`const {loadAskUserConfig}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(loadAskUserConfig()));`,
		], { env, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).promptSnippet, override ? "selected" : "default");
	});
}
