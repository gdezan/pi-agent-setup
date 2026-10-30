import assert from "node:assert/strict";
import test from "node:test";
import { questionStatusReport } from "../ask-user-status.ts";

test("reports the questionnaire as blocked, then restores the run's state", () => {
	const core = { HC_TERMINAL_ID: "t7" };
	assert.equal(questionStatusReport(true, false, core), "\x1b]7501;state=blocked:app=pi:kind=question\x1b\\");
	assert.equal(questionStatusReport(false, false, core), "\x1b]7501;state=working:app=pi\x1b\\");
	assert.equal(questionStatusReport(false, true, core), "\x1b]7501;state=idle:app=pi\x1b\\");
});

test("reports only where the terminal speaks OSC 7501 and Pi's override allows it", () => {
	assert.equal(questionStatusReport(true, false, {}), undefined);
	assert.equal(questionStatusReport(true, false, { HC_TERMINAL_ID: "t7", PI_PROGRAM_STATUS: "0" }), undefined);
	assert.ok(questionStatusReport(true, false, { PI_PROGRAM_STATUS: "1" }));
});
