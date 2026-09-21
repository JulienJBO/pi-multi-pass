// Regression check: subscriptions whose base provider is registered at
// runtime by a Pi extension (not a pi-ai built-in) must be registrable,
// login-able and refresh-able by pi-multi-pass.
//
// The fixture below mirrors what a real extension provider looks like in
// Pi's model registry: absent from builtinProviders(), present via
// modelRegistry.getRegisteredProviderConfig() (legacy oauth shape used by
// pi.registerProvider) and modelRegistry.getProvider() (composed provider
// whose auth.oauth carries the pi-ai OAuthAuth flow shape).
//
// Run with: node tests/extension-provider-oauth-check.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 1. Sandbox the agent dir before importing the extension (it reads
//    ~/.pi/agent/multi-pass.json on load).
// ---------------------------------------------------------------------------
const sandboxHome = mkdtempSync(join(tmpdir(), "mp-ext-oauth-"));
const agentDir = join(sandboxHome, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = sandboxHome;
delete process.env.MULTI_SUB;

const EXTENSION_PROVIDER_ID = "test-extension-oauth";
const EXTENSION_PROVIDER_NAME = "Extension Fixture";

// Seeded subscriptions: one extension-backed sub (the contract under test)
// plus one template sub for a provider that exists neither in the registry
// nor in the built-in catalog anymore (documents the observed
// google-antigravity failure) and one working built-in template sub
// (non-regression).
writeFileSync(
	join(agentDir, "multi-pass.json"),
	JSON.stringify({
		subscriptions: [
			{ provider: EXTENSION_PROVIDER_ID, index: 2 },
			{ provider: "google-antigravity", index: 2 },
			{ provider: "openai-codex", index: 2 },
		],
	}),
);

// ---------------------------------------------------------------------------
// 2. Fixture: a provider registered by a Pi extension.
// ---------------------------------------------------------------------------
const flowCalls = { login: 0, refresh: 0 };
const fixtureCredential = {
	type: "oauth",
	access: "ext-access",
	refresh: "ext-refresh",
	expires: 4102444800,
};

/** pi-ai OAuthAuth flow shape, as exposed by modelRegistry.getProvider().auth.oauth */
const fixtureFlow = {
	name: EXTENSION_PROVIDER_NAME,
	isSubscription: true,
	async login(_interaction) {
		flowCalls.login++;
		return { ...fixtureCredential };
	},
	async refresh(credential, _signal) {
		flowCalls.refresh++;
		return { ...credential, access: "ext-access-2" };
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

/** Legacy ExtensionOAuthConfig shape, as kept by modelRegistry.getRegisteredProviderConfig() */
const fixtureLegacyOAuth = {
	name: EXTENSION_PROVIDER_NAME,
	async login(_callbacks) {
		flowCalls.login++;
		return { ...fixtureCredential };
	},
	async refreshToken(credentials, _signal) {
		flowCalls.refresh++;
		return { ...credentials, access: "ext-access-2" };
	},
	getApiKey: (credentials) => credentials.access,
};

function fixtureModel(id, name) {
	return {
		id,
		name,
		provider: EXTENSION_PROVIDER_ID,
		api: "ext-api",
		baseUrl: "https://ext.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { currency: "usd", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	};
}
const fixtureModels = [
	fixtureModel("fixture-flash", "Fixture Flash"),
	fixtureModel("fixture-pro", "Fixture Pro"),
];
const fixtureStreamSimple = function fixtureStreamSimple() {
	return { kind: "fixture-stream" };
};

// ---------------------------------------------------------------------------
// 3. Fake Pi runtime objects.
// ---------------------------------------------------------------------------
const authStore = new Map();

const fakeRegistry = {
	authStorage: {
		hasAuth: (provider) => authStore.has(provider),
		get: (provider) => authStore.get(provider),
		logout: async (provider) => {
			authStore.delete(provider);
		},
	},
	getProvider(provider) {
		if (provider !== EXTENSION_PROVIDER_ID) return undefined;
		return {
			id: provider,
			name: EXTENSION_PROVIDER_NAME,
			baseUrl: "https://ext.example.com/v1",
			auth: { oauth: fixtureFlow },
		};
	},
	getRegisteredProviderConfig(provider) {
		if (provider !== EXTENSION_PROVIDER_ID) return undefined;
		return {
			name: EXTENSION_PROVIDER_NAME,
			baseUrl: "https://ext.example.com/v1",
			models: fixtureModels,
			oauth: fixtureLegacyOAuth,
			streamSimple: fixtureStreamSimple,
		};
	},
	getRegisteredProviderIds() {
		return [EXTENSION_PROVIDER_ID];
	},
	getAll() {
		return fixtureModels;
	},
	find(provider, modelId) {
		return fixtureModels.find((m) => m.provider === provider && m.id === modelId);
	},
	getProviderAuthStatus(provider) {
		return { configured: authStore.has(provider) };
	},
	async refresh() {
		return {};
	},
};

const registeredProviders = new Map();
const eventHandlers = new Map();
const commands = new Map();

const fakePi = {
	on(event, handler) {
		eventHandlers.set(event, handler);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
	registerProvider(name, config) {
		registeredProviders.set(name, config);
	},
	unregisterProvider(name) {
		registeredProviders.delete(name);
	},
	async setModel() {
		return true;
	},
};

const fakeCtx = {
	cwd: sandboxHome,
	model: undefined,
	hasUI: false,
	ui: {
		notify() {},
		setStatus() {},
	},
	modelRegistry: fakeRegistry,
};

// ---------------------------------------------------------------------------
// 4. Load the extension, then start a session the way Pi does.
// ---------------------------------------------------------------------------
const { default: loadExtension } = await import(
	new URL("../extensions/multi-sub.ts", import.meta.url)
);
loadExtension(fakePi);

assert.ok(eventHandlers.has("session_start"), "extension listens for session_start");
await eventHandlers.get("session_start")({}, fakeCtx);

// ---------------------------------------------------------------------------
// 5. The extension-backed subscription must be registered as a provider.
// ---------------------------------------------------------------------------
const subName = `${EXTENSION_PROVIDER_ID}-2`;
assert.ok(
	registeredProviders.has(subName),
	`subscription provider "${subName}" must be registered (extension providers are not PROVIDER_TEMPLATES)`,
);
const subConfig = registeredProviders.get(subName);

// ---------------------------------------------------------------------------
// 6. Its OAuth must route to the extension's own flow, for login AND refresh.
// ---------------------------------------------------------------------------
assert.ok(subConfig.oauth, "subscription provider must carry an oauth config");
const loginCallbacks = {
	onAuth() {},
	onPrompt: async () => "fixture",
	signal: new AbortController().signal,
};
const loggedIn = await subConfig.oauth.login(loginCallbacks);
assert.equal(flowCalls.login, 1, "login must call the extension provider's flow");
assert.equal(loggedIn.access, "ext-access");

const refreshed = await subConfig.oauth.refreshToken(
	{ ...fixtureCredential },
	new AbortController().signal,
);
assert.equal(flowCalls.refresh, 1, "refresh must call the extension provider's flow");
assert.equal(refreshed.access, "ext-access-2");
assert.equal(
	typeof subConfig.oauth.getApiKey,
	"function",
	"extension oauth getApiKey must be carried over (request auth derivation)",
);

// ---------------------------------------------------------------------------
// 7. Cloned models + transport must come from the registered provider:
//    without the streamSimple passthrough a sub for an extension provider
//    with a custom Api would load but fail on the first request.
// ---------------------------------------------------------------------------
assert.ok(Array.isArray(subConfig.models) && subConfig.models.length === 2,
	"subscription models must be cloned from the extension provider's registry models");
assert.deepEqual(
	subConfig.models.map((m) => m.id).sort(),
	["fixture-flash", "fixture-pro"],
);
assert.equal(subConfig.models[0].name, "Fixture Flash (#2)");
assert.equal(subConfig.baseUrl, "https://ext.example.com/v1");
assert.equal(subConfig.streamSimple, fixtureStreamSimple,
	"streamSimple must be passed through from the extension provider config");
assert.equal(subConfig.oauth.isSubscription, true,
	"isSubscription must be mirrored from the resolved provider flow");

const liveModels = await subConfig.refreshModels({
	credential: undefined,
	allowNetwork: false,
	publish: async () => true,
});
assert.ok(
	liveModels.every((m) => m.provider === subName),
	"refreshModels must keep models on the subscription provider",
);
assert.ok(
	liveModels.some((m) => m.id === "fixture-flash" && m.name === "Fixture Flash (#2)"),
	"refreshModels must re-clone the extension provider's models",
);

// ---------------------------------------------------------------------------
// 8. Built-in templates keep working (non-regression): openai-codex resolves
//    through the built-in fallback (registry miss) and mirrors its
//    subscription flag without any network access.
// ---------------------------------------------------------------------------
const codexConfig = registeredProviders.get("openai-codex-2");
assert.ok(codexConfig, "built-in template subscription must still register at load");
assert.ok(codexConfig.oauth, "built-in template subscription must keep its oauth config");
assert.equal(
	codexConfig.oauth.isSubscription,
	true,
	"built-in flow resolution must keep working (isSubscription mirrored)",
);

// ---------------------------------------------------------------------------
// 9. A provider that exists neither in the registry nor in the built-in
//    catalog must fail with the generic message — not one implying only
//    built-in flows are allowed.
// ---------------------------------------------------------------------------
const deadConfig = registeredProviders.get("google-antigravity-2");
assert.ok(deadConfig?.oauth, "template subscriptions register their oauth eagerly");
await assert.rejects(
	deadConfig.oauth.login(loginCallbacks),
	(err) => {
		assert.match(err.message, /No OAuth flow available for provider "google-antigravity"/);
		assert.doesNotMatch(err.message, /built-in/);
		return true;
	},
	"unresolvable provider must raise the generic 'No OAuth flow available' error",
);

// ---------------------------------------------------------------------------
// 10. Static guards (same style as the other checks): the resolver must look
//     at the runtime registry first and keep the built-in catalog as
//     fallback, with no third-party OAuth flow hardcoded.
// ---------------------------------------------------------------------------
const { readFile } = await import("node:fs/promises");
const source = await readFile(
	new URL("../extensions/multi-sub.ts", import.meta.url),
	"utf8",
);
assert.match(source, /function resolveOAuthFlow\(/);
assert.match(
	source,
	/modelRegistry\.getProvider\(providerId\)\?\.auth\?\.oauth/,
	"resolver must consult the runtime model registry",
);
assert.match(
	source,
	/builtinProviders\(\)\.find\(\(p\) => p\.id === providerId\)\?\.auth\?\.oauth/,
	"resolver must keep the built-in catalog fallback",
);
assert.doesNotMatch(source, /No built-in OAuth flow available/);

console.log("extension-provider-oauth checks passed");
