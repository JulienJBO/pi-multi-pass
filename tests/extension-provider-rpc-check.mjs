// Integration check against a real `pi` runtime: a subscription whose base
// provider is registered by another Pi extension must become usable
// mid-session (the exact mechanism behind /subs switch and /model).
//
// Spawns `pi --mode rpc` with two extensions loaded by the real loader:
//   - tests/fixtures/extension-fixture.ts registers "test-extension-oauth"
//     (absent from builtinProviders(), visible on the model registry)
//   - extensions/multi-sub.ts is the extension under test
//
// Run with: node tests/extension-provider-rpc-check.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-ext-rpc-"));

try {
	// A subscription whose base provider is registered by another extension.
	writeFileSync(
		join(agentDir, "multi-pass.json"),
		JSON.stringify({
			subscriptions: [{ provider: "test-extension-oauth", index: 2 }],
			pools: [],
			chains: [],
			presets: [],
		}),
	);
	// Stored oauth credential so the subscription counts as configured.
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"test-extension-oauth-2": {
				type: "oauth",
				access: "fixture-access",
				refresh: "fixture-refresh",
				expires: 4102444800,
			},
		}),
	);

	const result = spawnSync(
		"pi",
		[
			"--mode",
			"rpc",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension",
			join(root, "tests", "fixtures", "extension-fixture.ts"),
			"--extension",
			join(root, "extensions", "multi-sub.ts"),
		],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: [
				// Let the session start (extension providers are applied after the
				// load phase; multi-pass registers extension-backed subs on
				// session_start), then drive the same path /subs switch uses.
				'{"id":"settle","type":"prompt","message":"/subs status"}',
				'{"id":"pick","type":"set_model","provider":"test-extension-oauth-2","modelId":"fixture-flash"}',
			].join("\n") + "\n",
			encoding: "utf8",
			timeout: 30_000,
		},
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);

	const lines = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const pick = lines.find((line) => line.id === "pick");
	assert.ok(pick, "set_model response missing");
	assert.equal(
		pick.success,
		true,
		`selecting test-extension-oauth-2/fixture-flash must succeed: ${JSON.stringify(pick)}`,
	);
	assert.equal(pick.data?.name, "Fixture Flash (#2)");
	assert.equal(pick.data?.provider, "test-extension-oauth-2");

	console.log("extension-provider rpc check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
