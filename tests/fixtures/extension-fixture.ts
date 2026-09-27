import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Test fixture: an OAuth provider registered at runtime by a Pi extension,
 * the same registration shape pi-oauth-antigravity & co. use. Loading this
 * file with --extension simulates an extension provider for checks.
 */
export default function (pi: ExtensionAPI): void {
	pi.registerProvider("test-extension-oauth", {
		name: "Extension Fixture",
		baseUrl: "https://ext.example.com/v1",
		// A built-in Api id keeps registration valid; nothing streams in checks.
		api: "openai-responses",
		models: [
			{
				id: "fixture-flash",
				name: "Fixture Flash",
				reasoning: false,
				input: ["text"],
				cost: { currency: "usd", input: 0, output: 0 },
				contextWindow: 1_000_000,
				maxTokens: 8192,
			},
		],
		oauth: {
			name: "Extension Fixture",
			async login(callbacks) {
				callbacks.onAuth?.({
					url: "https://ext.example.com/oauth",
					instructions: "fixture login",
				});
				return {
					type: "oauth",
					access: "fixture-access",
					refresh: "fixture-refresh",
					expires: 4102444800,
				};
			},
			async refreshToken(credentials) {
				return { ...credentials, access: "fixture-access-2" };
			},
			getApiKey: (credentials) => credentials.access,
		},
	});
}
