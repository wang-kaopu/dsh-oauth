window.__ModuleLoader__.load({
	id: "@kelvinwww/dsh-oauth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client-locales.ts
		const en = {
			nav: "OAuth Providers",
			title: "OAuth Providers",
			intro: "Connect subscription accounts used by DSH models.",
			codexName: "Codex",
			codexDescription: "Use your ChatGPT subscription for Codex models.",
			geminiName: "Gemini CLI",
			geminiDescription: "Use Google OAuth with Gemini Code Assist.",
			connected: "Connected",
			notConnected: "Not connected",
			loginChatGPT: "Login with ChatGPT",
			loginGoogle: "Login with Google",
			logout: "Log out",
			working: "Working…",
			unavailable: "OAuth control server is unavailable.",
			popupBlocked: "The authorization page did not open automatically.",
			openAuthUrl: "Open it manually",
			operationFailed: "OAuth operation failed."
		};
		const zh = {
			nav: "OAuth 登录",
			title: "OAuth 登录",
			intro: "连接 DSH 模型使用的订阅账号。",
			codexName: "Codex",
			codexDescription: "使用 ChatGPT 订阅访问 Codex 模型。",
			geminiName: "Gemini CLI",
			geminiDescription: "使用 Google OAuth 连接 Gemini Code Assist。",
			connected: "已连接",
			notConnected: "未连接",
			loginChatGPT: "使用 ChatGPT 登录",
			loginGoogle: "使用 Google 登录",
			logout: "退出登录",
			working: "处理中…",
			unavailable: "OAuth 控制服务不可用。",
			popupBlocked: "授权页没有自动打开。",
			openAuthUrl: "手动打开",
			operationFailed: "OAuth 操作失败。"
		};
		//#endregion
		//#region src/client.tsx
		const NS = "settings.oauth";
		const inject = ["slots", "locale"];
		const styles = {
			section: {
				display: "flex",
				flexDirection: "column",
				width: "100%",
				maxWidth: 760,
				color: "var(--dsw-alias-label-primary)"
			},
			heading: {
				margin: 0,
				fontSize: 18,
				fontWeight: 600,
				lineHeight: 1.4
			},
			intro: {
				margin: "4px 0 12px",
				fontSize: 13,
				lineHeight: 1.5,
				color: "var(--dsw-alias-label-tertiary)"
			},
			providers: {
				display: "flex",
				flexDirection: "column"
			},
			provider: {
				display: "flex",
				alignItems: "center",
				gap: 16,
				minHeight: 64,
				padding: "14px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l2)"
			},
			providerInfo: {
				flex: 1,
				minWidth: 0
			},
			providerName: {
				fontSize: 14,
				fontWeight: 500,
				lineHeight: 1.5
			},
			providerDescription: {
				marginTop: 2,
				fontSize: 12,
				lineHeight: 1.5,
				color: "var(--dsw-alias-label-tertiary)"
			},
			actions: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexShrink: 0
			},
			error: {
				margin: "12px 0 0",
				fontSize: 12,
				lineHeight: 1.5,
				color: "var(--dsw-alias-label-error)"
			}
		};
		/**
		* Create the browser-side client for the OAuth control API.
		*
		* Prefers the same-origin `/plugins/oauth-bridge` route registered on the
		* harness `webServer` (the only path the desktop shell allows renderers to
		* reach); falls back to the standalone loopback control server when the route
		* is absent.
		*
		* @param routeUrl - same-origin control API prefix.
		* @param fallbackUrl - standalone loopback control server URL.
		* @returns status, login, and logout operations.
		*/
		function createOAuthBridgeClient(routeUrl = "/plugins/oauth-bridge", fallbackUrl = "http://127.0.0.1:1456") {
			let baseUrl = routeUrl;
			let probed = false;
			/** Select the reachable control API once per client instance. */
			async function probe() {
				if (probed) return;
				probed = true;
				try {
					const response = await fetch(`${routeUrl}/status`, { method: "GET" });
					const body = await response.json();
					if (response.ok && typeof body === "object" && body !== null) return;
				} catch {}
				baseUrl = fallbackUrl;
			}
			async function call(path, method) {
				await probe();
				const response = await fetch(`${baseUrl}${path}`, { method });
				const body = await response.json();
				if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `OAuth control request failed (${response.status})`);
				return body;
			}
			return {
				async status() {
					return await call("/status", "GET");
				},
				async login(provider) {
					const authUrl = (await call(`/auth/${provider}/start`, "POST")).authUrl;
					if (typeof authUrl !== "string") throw new Error("OAuth control response did not include authUrl");
					const popup = window.open(authUrl, "_blank");
					if (popup) popup.opener = null;
					return {
						authUrl,
						opened: popup !== null
					};
				},
				async logout(provider) {
					await call(`/auth/${provider}/logout`, "POST");
				}
			};
		}
		/**
		* Poll the loopback status endpoint until the browser callback has persisted credentials.
		*
		* @param provider - OAuth provider whose callback is being awaited.
		* @param client - loopback control client.
		* @param timeout - maximum wait duration in milliseconds.
		* @returns the status containing the authenticated provider.
		*/
		async function waitForAuthentication(provider, client, timeout = 6e4) {
			const deadline = Date.now() + timeout;
			while (Date.now() < deadline) {
				const status = await client.status();
				if (status[provider].authenticated) return status;
				await new Promise((resolve) => setTimeout(resolve, 1e3));
			}
			throw new Error(`${provider} OAuth callback was not completed before the status polling timeout`);
		}
		/** Render one provider's localized status and DSH-native action controls. */
		function ProviderRow(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.provider,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.providerInfo,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.providerName,
						children: props.name
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.providerDescription,
						children: props.description
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.actions,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
						active: props.authenticated,
						children: props.authenticated ? props.connectedLabel : props.notConnectedLabel
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: props.authenticated ? "outline" : "primary",
						disabled: props.busy,
						onClick: props.onAction,
						children: props.busy ? props.workingLabel : props.authenticated ? props.logoutLabel : props.loginLabel
					})]
				})]
			});
		}
		/** Render the OAuth provider controls used by the DSH settings slot. */
		function OAuthProviderPanel({ t }) {
			const client = createOAuthBridgeClient();
			const [status, setStatus] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [pendingAuthUrl, setPendingAuthUrl] = (0, react.useState)(void 0);
			const refresh = async () => {
				try {
					setStatus(await client.status());
					setError(void 0);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : t("unavailable"));
				}
			};
			(0, react.useEffect)(() => {
				let active = true;
				const poll = async () => {
					try {
						const next = await client.status();
						if (active) {
							setStatus(next);
							setError(void 0);
						}
					} catch (cause) {
						if (active) setError(cause instanceof Error ? cause.message : t("unavailable"));
					}
				};
				poll();
				const timer = window.setInterval(() => void poll(), 1e3);
				return () => {
					active = false;
					window.clearInterval(timer);
				};
			}, []);
			const handleAction = async (provider) => {
				setBusy(provider);
				try {
					if (status?.[provider].authenticated) await client.logout(provider);
					else {
						const login = await client.login(provider);
						setPendingAuthUrl(login.opened ? void 0 : login.authUrl);
						await waitForAuthentication(provider, client);
					}
					await refresh();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : t("operationFailed"));
				} finally {
					setPendingAuthUrl(void 0);
					setBusy(void 0);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: styles.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: styles.heading,
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.intro,
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.providers,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderRow, {
							name: t("codexName"),
							description: t("codexDescription"),
							authenticated: status?.codex.authenticated === true,
							busy: busy === "codex",
							loginLabel: t("loginChatGPT"),
							connectedLabel: t("connected"),
							notConnectedLabel: t("notConnected"),
							logoutLabel: t("logout"),
							workingLabel: t("working"),
							onAction: () => void handleAction("codex")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderRow, {
							name: t("geminiName"),
							description: t("geminiDescription"),
							authenticated: status?.gemini.authenticated === true,
							busy: busy === "gemini",
							loginLabel: t("loginGoogle"),
							connectedLabel: t("connected"),
							notConnectedLabel: t("notConnected"),
							logoutLabel: t("logout"),
							workingLabel: t("working"),
							onAction: () => void handleAction("gemini")
						})]
					}),
					pendingAuthUrl !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: styles.error,
						children: [
							t("popupBlocked"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: pendingAuthUrl,
								target: "_blank",
								rel: "noreferrer",
								style: {
									color: "var(--dsw-alias-label-error)",
									textDecoration: "underline"
								},
								children: t("openAuthUrl")
							})
						]
					}) : null,
					error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						style: styles.error,
						children: error
					}) : null
				]
			});
		}
		/**
		* Register the OAuth panel in the DSH Web settings surface.
		*
		* @param ctx - DSH client context providing the settings and locale services.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-oauth: settings locale");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-oauth",
				order: 5,
				label: () => ctx.locale.bind(NS)("nav"),
				locale: NS
			}, OAuthProviderPanel));
		}
		//#endregion
		exports.apply = apply;
		exports.createOAuthBridgeClient = createOAuthBridgeClient;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map