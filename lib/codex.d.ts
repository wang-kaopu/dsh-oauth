import type { Context } from '@deepseek-ai/cordis';
export declare const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export declare const CODEX_ISSUER = "https://auth.openai.com";
export declare const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export declare const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export declare const CODEX_REDIRECT_PORT = 1455;
export declare const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export declare const CODEX_TOKEN_REF: import("@deepseek-ai/dsh-credentials").CredentialRef;
export interface CodexServiceConfig {
    dshHome?: string;
    codexRedirectPort?: number;
    onAuthStateChange?: (authenticated: boolean) => void | Promise<void>;
}
declare function createPkce(): {
    verifier: string;
    challenge: string;
};
declare function decodeJwtPayload(token: string): Record<string, unknown> | undefined;
declare function accountIdFromTokens(accessToken: string, idToken?: string): string | undefined;
/**
 * Create the Codex OAuth bridge for one DSH context.
 *
 * @param ctx - DSH context owning credentials and logging.
 * @param config - storage and callback-port configuration.
 * @returns the Codex login, refresh, status, and cleanup operations.
 */
export declare function createCodexService(ctx: Context, config?: CodexServiceConfig): {
    startCodexLogin: () => Promise<{
        authUrl: string;
    }>;
    getCodexAccessToken: () => Promise<string>;
    initialize: () => Promise<void>;
    logout: () => Promise<void>;
    dispose: () => Promise<void>;
};
export { createPkce, decodeJwtPayload, accountIdFromTokens };
//# sourceMappingURL=codex.d.ts.map