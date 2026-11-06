import type { Context } from '@deepseek-ai/cordis';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';
export declare const CODEX_PROVIDER = "openai-codex";
export declare const GEMINI_PROVIDER = "gemini-cli-oauth";
/**
 * Synchronize the Codex settings profile with its OAuth authentication state without taking ownership of user routes.
 *
 * @param ctx - DSH context owning the settings provider.
 * @param dshHome - optional DSH home used for the persisted ownership marker.
 * @returns an idempotent route synchronization function.
 */
export declare function createCodexRouteSync(ctx: Context, dshHome?: string): (authenticated: boolean) => Promise<void>;
/**
 * Synchronize the Gemini adapter registration with its OAuth authentication state.
 *
 * @param ctx - DSH context owning the LLM registry.
 * @param adapter - Gemini adapter instance to expose when authenticated.
 * @returns an idempotent route synchronization function.
 */
export declare function createGeminiRouteSync(ctx: Context, adapter: LlmAdapter): (authenticated: boolean) => void;
//# sourceMappingURL=routes.d.ts.map