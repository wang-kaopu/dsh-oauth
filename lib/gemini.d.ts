import { OAuth2Client } from 'google-auth-library';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
export declare const GEMINI_SCOPES: readonly ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];
export declare const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export declare const CODE_ASSIST_API_VERSION = "v1internal";
export declare const GEMINI_CLIENT_ID_ENV = "GEMINI_CLIENT_ID";
export declare const GEMINI_CLIENT_SECRET_ENV = "GEMINI_CLIENT_SECRET";
export declare const GEMINI_CLIENT_ID: string;
export declare const GEMINI_CLIENT_SECRET: string;
export declare const GEMINI_MODEL_CACHE_TTL_MS: number;
export interface GeminiServiceConfig {
    dshHome?: string;
    clientId?: string;
    clientSecret?: string;
    /** Optional Google Cloud project id (paid tiers); falls back to GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID. */
    projectId?: string;
    createClient?: (clientId: string, clientSecret: string) => OAuth2Client;
    onAuthStateChange?: (authenticated: boolean) => void | Promise<void>;
}
interface GeminiRequestOptions {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    params?: Record<string, string>;
    responseType?: 'stream';
    signal?: AbortSignal;
}
export interface GeminiTransport {
    getProjectId(signal?: AbortSignal): Promise<string>;
    requestJson<T>(options: GeminiRequestOptions): Promise<T>;
    requestStream(options: GeminiRequestOptions): Promise<AsyncIterable<Uint8Array | string>>;
    getAccessToken(): Promise<string>;
    listModels(signal?: AbortSignal): Promise<readonly string[]>;
}
/**
 * Build a Code Assist method URL from the stable endpoint and API version.
 *
 * @param method - v1internal method name such as `loadCodeAssist`.
 * @returns the method URL.
 */
export declare function getMethodUrl(method: string): string;
/**
 * Create a Google OAuth client from explicit credentials.
 *
 * @param clientId - Google installed-app OAuth client ID.
 * @param clientSecret - Google installed-app OAuth client secret.
 * @returns an OAuth2 client that owns refresh behavior.
 */
export declare function createGeminiOAuthClient(clientId: string, clientSecret: string): OAuth2Client;
/**
 * Find an unused loopback TCP port.
 *
 * @returns an OS-assigned local port.
 */
export declare function getAvailablePort(): Promise<number>;
/**
 * Parse a line-oriented SSE stream without buffering the whole response.
 *
 * @param stream - byte or string chunks from the HTTP response.
 * @param onMalformed - optional diagnostic callback for malformed JSON events.
 * @yields parsed SSE data objects.
 */
export declare function parseSse(stream: AsyncIterable<Uint8Array | string>, onMalformed?: (error: unknown) => void): AsyncIterable<Record<string, unknown>>;
/**
 * Create the Gemini Code Assist OAuth and transport service.
 *
 * @param ctx - DSH context used for lifecycle-safe diagnostics.
 * @param config - storage, OAuth, and test transport configuration.
 * @returns the service consumed by the adapter and control server.
 */
export declare function createGeminiService(ctx: Context, config?: GeminiServiceConfig): GeminiTransport & {
    startGeminiLogin(): Promise<{
        authUrl: string;
    }>;
    initialize(): Promise<void>;
    logout(): Promise<void>;
    dispose(): Promise<void>;
    isAuthenticated(): Promise<boolean>;
    ensureGeminiCodeAssistSetup(client?: OAuth2Client): Promise<{
        projectId: string;
    }>;
};
/**
 * Convert Gemini Code Assist streaming events into DSH stream chunks.
 *
 * @param transport - authenticated Gemini transport.
 * @param options - provider-neutral DSH generation request.
 * @returns an async stream ending with exactly one finish chunk.
 */
export declare function streamGemini(transport: GeminiTransport, options: GenerateOptions): AsyncIterable<StreamChunk>;
/**
 * DSH adapter for the Gemini CLI Code Assist route.
 */
export declare class GeminiCliAdapter extends LlmAdapter {
    private readonly transport;
    constructor(transport: GeminiTransport);
    /**
     * Stream one DSH request through Gemini Code Assist.
     *
     * @param options - provider-neutral model request.
     * @returns translated DSH stream chunks.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * Return the configured route's currently selected project metadata.
     *
     * @param provider - registered provider route.
     * @returns provider/model descriptor.
     */
    resolveModel(provider: string, model: string): Promise<{
        provider: string;
        id: string;
        name: string;
    }>;
    /**
     * Keep model discovery advisory; the DSH configuration supplies the model ID.
     *
     * @param provider - provider route being queried.
     * @returns no fabricated model IDs.
     */
    listModels(provider: string): Promise<readonly {
        provider: string;
        id: string;
        name: string;
    }[]>;
}
export {};
//# sourceMappingURL=gemini.d.ts.map