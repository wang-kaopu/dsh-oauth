import { OAuth2Client } from 'google-auth-library';
import { attributionHeaders, LlmAdapter, LlmError, ToolCallId, } from '@deepseek-ai/dsh-llm';
import { createServer } from 'node:http';
import * as net from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { clearGeminiCredential, loadGeminiCredential, saveGeminiCredential, } from './storage.js';
export const GEMINI_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];
export const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const CODE_ASSIST_API_VERSION = 'v1internal';
export const GEMINI_CLIENT_ID_ENV = 'GEMINI_CLIENT_ID';
export const GEMINI_CLIENT_SECRET_ENV = 'GEMINI_CLIENT_SECRET';
export const GEMINI_CLIENT_ID = process.env[GEMINI_CLIENT_ID_ENV] ?? '';
export const GEMINI_CLIENT_SECRET = process.env[GEMINI_CLIENT_SECRET_ENV] ?? '';
export const GEMINI_MODEL_CACHE_TTL_MS = 5 * 60_000;
/**
 * Build a Code Assist method URL from the stable endpoint and API version.
 *
 * @param method - v1internal method name such as `loadCodeAssist`.
 * @returns the method URL.
 */
export function getMethodUrl(method) {
    return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;
}
/**
 * Create a Google OAuth client from explicit credentials.
 *
 * @param clientId - Google installed-app OAuth client ID.
 * @param clientSecret - Google installed-app OAuth client secret.
 * @returns an OAuth2 client that owns refresh behavior.
 */
export function createGeminiOAuthClient(clientId, clientSecret) {
    return new OAuth2Client({ clientId, clientSecret });
}
/**
 * Find an unused loopback TCP port.
 *
 * @returns an OS-assigned local port.
 */
export async function getAvailablePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : undefined;
    await new Promise(resolve => server.close(() => resolve()));
    if (!port)
        throw new Error('The operating system did not provide a loopback port');
    return port;
}
/**
 * Parse a line-oriented SSE stream without buffering the whole response.
 *
 * @param stream - byte or string chunks from the HTTP response.
 * @param onMalformed - optional diagnostic callback for malformed JSON events.
 * @yields parsed SSE data objects.
 */
export async function* parseSse(stream, onMalformed = () => console.debug('Gemini SSE event was malformed and was skipped')) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let dataLines = [];
    const flushEvent = function* () {
        if (dataLines.length === 0)
            return;
        const data = dataLines.join('\n');
        dataLines = [];
        if (data === '[DONE]')
            return;
        try {
            const parsed = JSON.parse(data);
            if (typeof parsed === 'object' && parsed !== null)
                yield parsed;
        }
        catch (error) {
            onMalformed(error);
        }
    };
    const consumeLine = function* (line) {
        const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (normalized === '') {
            yield* flushEvent();
            return;
        }
        if (normalized.startsWith('data: '))
            dataLines.push(normalized.slice(6));
        else if (normalized.startsWith('data:'))
            dataLines.push(normalized.slice(5).replace(/^ /, ''));
    };
    for await (const chunk of stream) {
        pendingText += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        let newlineIndex = pendingText.indexOf('\n');
        while (newlineIndex >= 0) {
            yield* consumeLine(pendingText.slice(0, newlineIndex));
            pendingText = pendingText.slice(newlineIndex + 1);
            newlineIndex = pendingText.indexOf('\n');
        }
    }
    pendingText += decoder.decode();
    if (pendingText.length > 0)
        yield* consumeLine(pendingText);
    yield* flushEvent();
}
function geminiError(message, code, cause, status) {
    return new LlmError(message, code, { ...(cause === undefined ? {} : { cause }), ...(status === undefined ? {} : { status }) });
}
function projectIdIsNumeric(projectId) {
    return /^\d+$/.test(projectId);
}
function selectedProjectId(stored, configured) {
    const value = configured ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID ?? stored?.projectId;
    if (value !== undefined && projectIdIsNumeric(value))
        throw geminiError('A Google Cloud project number cannot be used as a project ID', 'GEMINI_INVALID_PROJECT_ID');
    return value;
}
function errorCodeFromResponse(error, fallback) {
    const value = `${error?.status ?? ''} ${error?.message ?? ''}`.toUpperCase();
    if (value.includes('VALIDATION'))
        return 'GEMINI_VALIDATION_REQUIRED';
    if (value.includes('ELIGIBLE'))
        return 'GEMINI_ACCOUNT_NOT_ELIGIBLE';
    if (value.includes('SERVICE_DISABLED') || value.includes('ACCESSNOTCONFIGURED') || value.includes('HAS NOT BEEN USED'))
        return 'GEMINI_SERVICE_DISABLED';
    return fallback;
}
/** Map Code Assist account eligibility reasons to the bridge's stable error codes. */
function ineligibleTierErrorCode(tiers) {
    if (!tiers?.length)
        return undefined;
    if (tiers.some(tier => tier.reasonCode === 'VALIDATION_REQUIRED'))
        return 'GEMINI_VALIDATION_REQUIRED';
    return 'GEMINI_ACCOUNT_NOT_ELIGIBLE';
}
/** Extract the structured Gaxios response needed for stable provider error classification. */
function errorResponse(error) {
    const response = error.response;
    const data = typeof response?.data === 'object' && response.data !== null ? response.data : undefined;
    return { status: response?.status, data };
}
/** Identify OAuth failures that prove the stored Gemini refresh credential is unusable. */
function isPermanentAuthFailure(error) {
    if (error.code === 'GEMINI_AUTH_REQUIRED')
        return true;
    const { status, data } = errorResponse(error);
    if (status === 401)
        return true;
    return typeof data?.error === 'string' && data.error === 'invalid_grant';
}
function responseHtml(message) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>DSH OAuth Bridge</title></head><body><p>${message}</p><p>You can close this window.</p></body></html>`;
}
function sendResponse(response, status, message) {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(responseHtml(message));
}
async function closeServer(server) {
    if (!server.listening)
        return;
    await new Promise(resolve => server.close(() => resolve()));
}
function delay(milliseconds, signal) {
    if (signal?.aborted)
        return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function isFreeTier(tier) {
    return `${tier.id ?? ''} ${tier.name ?? ''}`.toLowerCase().includes('free');
}
function contentParts(message, toolNames) {
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text') {
            parts.push({ text: block.text });
            continue;
        }
        if (block.type === 'reasoning')
            throw geminiError('Gemini does not support reasoning history', 'GEMINI_REASONING_HISTORY_UNSUPPORTED');
        if (block.type === 'tool-call') {
            let args = {};
            try {
                args = JSON.parse(block.arguments);
            }
            catch {
                throw geminiError('A tool call contained invalid JSON arguments', 'GEMINI_STREAM_ERROR');
            }
            parts.push({ functionCall: { name: block.name, args } });
            continue;
        }
        if (block.type === 'tool-addition' || block.type === 'tool-removal')
            continue;
        throw geminiError(`Gemini does not support DSH content block ${block.type}`, 'GEMINI_STREAM_ERROR');
    }
    return parts;
}
/**
 * Convert dsh 0.2.x role-based messages into Gemini Code Assist contents.
 * Tool results arrive as first-class `tool`-role messages; the mapping sends
 * their `functionResponse` parts inside a `user`-role turn, which is the
 * shape Gemini Code Assist expects. System-role messages are collected
 * separately into the request-level system instruction.
 */
function convertContents(messages) {
    const toolNames = new Map();
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === 'tool-call')
                toolNames.set(block.id, block.name);
        }
    }
    return messages.map(message => {
        if (message.role === 'assistant') {
            return { role: 'model', parts: contentParts(message, toolNames) };
        }
        if (message.role === 'tool') {
            const response = {};
            for (const block of message.content) {
                if (block.type === 'text')
                    response.output = `${response.output ?? ''}${block.text}`;
            }
            if (message.isError)
                response.error = true;
            return {
                role: 'user',
                parts: [{ functionResponse: { name: toolNames.get(message.toolCallId) ?? message.toolCallId, response } }],
            };
        }
        return { role: 'user', parts: contentParts(message, toolNames) };
    });
}
function convertTools(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    return [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
}
function toGenerateRequest(options, project) {
    const generationConfig = {
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
        ...(options.stop === undefined ? {} : { stopSequences: options.stop }),
    };
    const systemTexts = [];
    const messages = [];
    for (const message of options.messages) {
        if (message.role === 'system') {
            for (const block of message.content) {
                if (block.type === 'text')
                    systemTexts.push(block.text);
            }
            continue;
        }
        messages.push(message);
    }
    const system = options.system === undefined
        ? systemTexts.join('\n\n')
        : [options.system, ...systemTexts].join('\n\n');
    return {
        model: options.model,
        project,
        ...(options.sessionId === undefined ? {} : { user_prompt_id: String(options.sessionId) }),
        request: {
            contents: convertContents(messages),
            ...(system.length === 0 ? {} : { systemInstruction: { parts: [{ text: system }] } }),
            ...(convertTools(options.tools) === undefined ? {} : { tools: convertTools(options.tools) }),
            ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
            ...(options.sessionId === undefined ? {} : { session_id: String(options.sessionId) }),
        },
    };
}
function responseFromEvent(event) {
    const response = event.response;
    return typeof response === 'object' && response !== null ? response : undefined;
}
function responseParts(response) {
    const candidates = response.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0)
        return [];
    const content = candidates[0];
    if (typeof content !== 'object' || content === null)
        return [];
    const candidateContent = content.content;
    if (typeof candidateContent !== 'object' || candidateContent === null)
        return [];
    const parts = candidateContent.parts;
    return Array.isArray(parts) ? parts.filter((part) => typeof part === 'object' && part !== null) : [];
}
/**
 * Create the Gemini Code Assist OAuth and transport service.
 *
 * @param ctx - DSH context used for lifecycle-safe diagnostics.
 * @param config - storage, OAuth, and test transport configuration.
 * @returns the service consumed by the adapter and control server.
 */
export function createGeminiService(ctx, config = {}) {
    const clientId = config.clientId ?? process.env[GEMINI_CLIENT_ID_ENV] ?? GEMINI_CLIENT_ID;
    const clientSecret = config.clientSecret ?? process.env[GEMINI_CLIENT_SECRET_ENV] ?? GEMINI_CLIENT_SECRET;
    const makeClient = config.createClient ?? createGeminiOAuthClient;
    let client;
    let projectCache;
    let pending;
    let modelCache;
    let lastAuthState;
    let authStateRetryTimer;
    let modelRefresh;
    let modelGeneration = 0;
    /** Cancel the one-shot retry for a failed route synchronization. */
    function clearAuthStateRetry() {
        if (authStateRetryTimer === undefined)
            return;
        clearTimeout(authStateRetryTimer);
        authStateRetryTimer = undefined;
    }
    /** Retry one failed route synchronization without changing the completed OAuth transaction. */
    function scheduleAuthStateRetry(authenticated) {
        clearAuthStateRetry();
        authStateRetryTimer = setTimeout(() => {
            authStateRetryTimer = undefined;
            if (lastAuthState !== authenticated)
                return;
            void (async () => {
                try {
                    await config.onAuthStateChange?.(authenticated);
                }
                catch (error) {
                    ctx.logger.warn(`OAuth route sync retry failed (${error instanceof Error ? error.message : String(error)})`);
                }
            })();
        }, 1_000);
        authStateRetryTimer.unref?.();
    }
    /** Publish an authentication transition without allowing route failures to fail OAuth. */
    async function publishAuthState(authenticated) {
        if (authenticated === lastAuthState)
            return;
        lastAuthState = authenticated;
        clearAuthStateRetry();
        try {
            await config.onAuthStateChange?.(authenticated);
        }
        catch (error) {
            ctx.logger.warn(`OAuth route sync failed (${error instanceof Error ? error.message : String(error)})`);
            scheduleAuthStateRetry(authenticated);
        }
    }
    /** Invalidate cached model discovery and any in-flight result from the previous auth session. */
    function invalidateModelDiscovery() {
        modelGeneration += 1;
        modelCache = undefined;
        modelRefresh = undefined;
    }
    /** Revoke persisted Gemini authentication after a confirmed permanent auth failure. */
    async function revokeAuthentication() {
        invalidateModelDiscovery();
        await clearGeminiCredential(config.dshHome);
        client = undefined;
        projectCache = undefined;
        await publishAuthState(false);
    }
    async function persistTokens(tokens) {
        const old = await loadGeminiCredential(config.dshHome);
        if (!old)
            return;
        await saveGeminiCredential({
            ...old,
            ...(tokens.access_token == null ? {} : { accessToken: tokens.access_token }),
            ...(tokens.refresh_token == null ? {} : { refreshToken: tokens.refresh_token }),
            ...(tokens.expiry_date == null ? {} : { expiresAt: tokens.expiry_date }),
        }, config.dshHome);
    }
    function attachTokenPersistence(oauthClient) {
        oauthClient.on('tokens', tokens => {
            void persistTokens(tokens).catch(() => ctx.logger.warn('Gemini token persistence failed'));
        });
    }
    async function getClient() {
        if (client)
            return client;
        if (!clientId || !clientSecret)
            throw geminiError('Gemini OAuth client credentials are not configured', 'GEMINI_OAUTH_FAILED');
        const stored = await loadGeminiCredential(config.dshHome);
        if (!stored?.refreshToken)
            throw geminiError('Gemini authentication is required', 'GEMINI_AUTH_REQUIRED');
        client = makeClient(clientId, clientSecret);
        attachTokenPersistence(client);
        client.setCredentials({
            ...(stored.accessToken === undefined ? {} : { access_token: stored.accessToken }),
            refresh_token: stored.refreshToken,
            ...(stored.expiresAt === undefined ? {} : { expiry_date: stored.expiresAt }),
        });
        return client;
    }
    async function getAccessToken() {
        try {
            const oauthClient = await getClient();
            const result = await oauthClient.getAccessToken();
            if (!result.token)
                throw geminiError('Gemini OAuth did not return an access token', 'GEMINI_AUTH_REQUIRED');
            return result.token;
        }
        catch (error) {
            if (isPermanentAuthFailure(error)) {
                await revokeAuthentication();
                if (error.code === 'GEMINI_AUTH_REQUIRED')
                    throw error;
                throw geminiError('Gemini authentication is required', 'GEMINI_AUTH_REQUIRED', error, errorResponse(error).status);
            }
            throw geminiError('Gemini OAuth token refresh failed', 'GEMINI_REFRESH_FAILED', error);
        }
    }
    async function requestJson(options) {
        try {
            const oauthClient = await getClient();
            const response = await oauthClient.request({ ...options, headers: { ...(options.headers ?? {}), 'content-type': options.headers?.['content-type'] ?? 'application/json' } });
            if (response.status !== undefined && response.status >= 400) {
                const data = response.data;
                throw geminiError('Gemini Code Assist request failed', response.status === 401 ? 'GEMINI_AUTH_REQUIRED' : errorCodeFromResponse(data.error, 'GEMINI_HTTP_ERROR'), undefined, response.status);
            }
            return response.data;
        }
        catch (error) {
            const thrown = error.code;
            if (typeof thrown === 'string' && thrown.startsWith('GEMINI_')) {
                if (thrown === 'GEMINI_AUTH_REQUIRED')
                    await revokeAuthentication();
                throw error;
            }
            const { status, data } = errorResponse(error);
            if (isPermanentAuthFailure(error)) {
                await revokeAuthentication();
                throw geminiError('Gemini authentication is required', 'GEMINI_AUTH_REQUIRED', error, status);
            }
            throw geminiError('Gemini Code Assist request failed', errorCodeFromResponse(data?.error, 'GEMINI_HTTP_ERROR'), error, status);
        }
    }
    async function requestStream(options) {
        try {
            const oauthClient = await getClient();
            const response = await oauthClient.request({ ...options, responseType: 'stream', headers: { ...(options.headers ?? {}), 'content-type': options.headers?.['content-type'] ?? 'application/json' } });
            if (response.status !== undefined && response.status >= 400) {
                throw geminiError('Gemini stream request failed', response.status === 401 ? 'GEMINI_AUTH_REQUIRED' : 'GEMINI_HTTP_ERROR', undefined, response.status);
            }
            return response.data;
        }
        catch (error) {
            const thrown = error.code;
            if (typeof thrown === 'string' && thrown.startsWith('GEMINI_')) {
                if (thrown === 'GEMINI_AUTH_REQUIRED')
                    await revokeAuthentication();
                throw error;
            }
            const { status, data } = errorResponse(error);
            if (isPermanentAuthFailure(error)) {
                await revokeAuthentication();
                throw geminiError('Gemini authentication is required', 'GEMINI_AUTH_REQUIRED', error, status);
            }
            throw geminiError('Gemini stream request failed', errorCodeFromResponse(data?.error, 'GEMINI_HTTP_ERROR'), error, status);
        }
    }
    async function ensureGeminiCodeAssistSetup(oauthClient, signal) {
        const activeClient = oauthClient ?? await getClient();
        client ??= activeClient;
        const stored = await loadGeminiCredential(config.dshHome);
        const localProjectId = selectedProjectId(stored, config.projectId);
        const request = {
            cloudaicompanionProject: localProjectId,
            metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', ...(localProjectId === undefined ? {} : { duetProject: localProjectId }) },
        };
        const load = await requestJson({ url: getMethodUrl('loadCodeAssist'), method: 'POST', body: JSON.stringify(request), headers: attributionHeaders(), signal });
        let resolvedProject = load.cloudaicompanionProject ?? localProjectId;
        if (!load.currentTier) {
            // An ineligible tier entry only explains why a tier is NOT offered (for
            // example the free individual tier refusing a migrated client); it does
            // not make the account ineligible when an allowed tier is available.
            // Select the default allowed tier first, and only consult
            // ineligibleTiers for the diagnosis when nothing is allowed.
            const tier = load.allowedTiers?.find(candidate => candidate.isDefault) ?? load.allowedTiers?.[0];
            if (!tier?.id) {
                const ineligibleCode = ineligibleTierErrorCode(load.ineligibleTiers);
                if (ineligibleCode) {
                    const message = ineligibleCode === 'GEMINI_VALIDATION_REQUIRED'
                        ? 'Gemini Code Assist account validation is required'
                        : 'Gemini Code Assist account is not eligible';
                    throw geminiError(message, ineligibleCode);
                }
                throw geminiError('Gemini Code Assist returned no default tier', 'GEMINI_NO_ALLOWED_TIER');
            }
            if (!isFreeTier(tier) && !localProjectId)
                throw geminiError('A Google Cloud project is required for the selected Gemini tier', 'GEMINI_PROJECT_REQUIRED');
            const onboardRequest = {
                tierId: tier.id,
                ...(isFreeTier(tier) ? {} : { cloudaicompanionProject: localProjectId }),
                metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', ...(isFreeTier(tier) ? {} : { duetProject: localProjectId }) },
            };
            let operation = await requestJson({ url: getMethodUrl('onboardUser'), method: 'POST', body: JSON.stringify(onboardRequest), headers: attributionHeaders(), signal });
            if (operation.done === false && operation.name) {
                const deadline = Date.now() + 60_000;
                while (!operation.done && Date.now() < deadline) {
                    await delay(5_000, signal);
                    operation = await requestJson({ url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}/${operation.name}`, method: 'GET', headers: attributionHeaders(), signal });
                }
                if (!operation.done)
                    throw geminiError('Gemini Code Assist onboarding timed out', 'GEMINI_ONBOARDING_TIMEOUT');
            }
            if (operation.error)
                throw geminiError('Gemini Code Assist onboarding failed', errorCodeFromResponse(operation.error, 'GEMINI_ONBOARDING_FAILED'));
            resolvedProject = operation.response?.cloudaicompanionProject?.id ?? localProjectId;
        }
        if (!resolvedProject)
            throw geminiError('Gemini Code Assist did not return a project ID', 'GEMINI_PROJECT_REQUIRED');
        if (projectIdIsNumeric(resolvedProject))
            throw geminiError('Gemini Code Assist returned a project number instead of a project ID', 'GEMINI_INVALID_PROJECT_ID');
        if (projectCache !== undefined && projectCache !== resolvedProject)
            invalidateModelDiscovery();
        projectCache = resolvedProject;
        const latest = await loadGeminiCredential(config.dshHome);
        if (latest)
            await saveGeminiCredential({ ...latest, projectId: resolvedProject }, config.dshHome);
        ctx.logger.info('Gemini Code Assist setup completed');
        return { projectId: resolvedProject };
    }
    async function getProjectId(signal) {
        if (projectCache)
            return projectCache;
        return (await ensureGeminiCodeAssistSetup(undefined, signal)).projectId;
    }
    /** Discover the account's current Code Assist model buckets with a short-lived last-known-good cache. */
    async function listModels(signal) {
        if (modelCache && modelCache.expiresAt > Date.now())
            return modelCache.models;
        if (modelRefresh)
            return modelRefresh;
        const generation = modelGeneration;
        if (!(await isAuthenticated()))
            return [];
        if (generation !== modelGeneration)
            return [];
        if (modelRefresh)
            return modelRefresh;
        const previous = modelCache;
        const refresh = (async () => {
            try {
                const project = await getProjectId(signal);
                const response = await requestJson({
                    url: getMethodUrl('retrieveUserQuota'),
                    method: 'POST',
                    headers: attributionHeaders(),
                    body: JSON.stringify({ project }),
                    signal,
                });
                if (generation !== modelGeneration)
                    return [];
                const models = [...new Set((response.buckets ?? [])
                        .map(bucket => bucket.modelId?.trim())
                        .filter((model) => Boolean(model)))];
                if (models.length === 0 && previous?.models.length) {
                    ctx.logger.warn('Gemini model discovery returned no model IDs; using cached models');
                    return previous.models;
                }
                modelCache = { models, expiresAt: Date.now() + GEMINI_MODEL_CACHE_TTL_MS };
                return models;
            }
            catch (error) {
                if (generation !== modelGeneration)
                    return [];
                if (error.code === 'GEMINI_AUTH_REQUIRED')
                    throw error;
                if (previous) {
                    ctx.logger.warn('Gemini model refresh failed; using cached models');
                    return previous.models;
                }
                throw error;
            }
        })();
        modelRefresh = refresh;
        try {
            return await refresh;
        }
        finally {
            if (modelRefresh === refresh)
                modelRefresh = undefined;
        }
    }
    async function handleCallback(request, response) {
        const login = pending;
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/oauth2callback') {
            sendResponse(response, 404, 'Not found');
            return;
        }
        if (!login) {
            sendResponse(response, 400, 'No pending Gemini login');
            return;
        }
        try {
            if (requestUrl.searchParams.get('error'))
                throw geminiError('Gemini OAuth authorization was denied', 'GEMINI_OAUTH_FAILED');
            if (requestUrl.searchParams.get('state') !== login.state)
                throw geminiError('Gemini OAuth state did not match', 'GEMINI_OAUTH_STATE_MISMATCH');
            const code = requestUrl.searchParams.get('code');
            if (!code)
                throw geminiError('Gemini OAuth callback did not include a code', 'GEMINI_OAUTH_FAILED');
            const { tokens } = await login.client.getToken({ code, redirect_uri: login.redirectUri });
            if (!tokens.refresh_token)
                throw geminiError('Gemini OAuth did not return a refresh token', 'GEMINI_REFRESH_TOKEN_MISSING');
            login.client.setCredentials(tokens);
            await saveGeminiCredential({
                ...(tokens.access_token == null ? {} : { accessToken: tokens.access_token }),
                refreshToken: tokens.refresh_token,
                ...(tokens.expiry_date == null ? {} : { expiresAt: tokens.expiry_date }),
            }, config.dshHome);
            client = login.client;
            invalidateModelDiscovery();
            await ensureGeminiCodeAssistSetup(login.client);
            await publishAuthState(true);
            ctx.logger.info('Gemini login succeeded');
            sendResponse(response, 200, 'Gemini login succeeded');
        }
        catch (error) {
            const code = error.code ?? 'GEMINI_OAUTH_FAILED';
            ctx.logger.warn(`Gemini login failed (${code})`);
            sendResponse(response, code === 'GEMINI_OAUTH_STATE_MISMATCH' ? 400 : 500, 'Gemini login failed');
        }
        finally {
            pending = undefined;
            await closeServer(login.server);
        }
    }
    async function startGeminiLogin() {
        if (!clientId || !clientSecret)
            throw geminiError('Gemini OAuth client credentials are not configured', 'GEMINI_OAUTH_FAILED');
        if (pending)
            await closeServer(pending.server);
        const port = await getAvailablePort();
        const oauthClient = makeClient(clientId, clientSecret);
        attachTokenPersistence(oauthClient);
        const state = randomBytes(32).toString('base64url');
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const server = createServer((request, response) => {
            void handleCallback(request, response);
        });
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
        });
        pending = { server, client: oauthClient, state, redirectUri };
        const authUrl = oauthClient.generateAuthUrl({ access_type: 'offline', scope: [...GEMINI_SCOPES], state, redirect_uri: redirectUri });
        ctx.logger.info('Gemini login started');
        return { authUrl };
    }
    async function initialize() {
        if (!(await isAuthenticated())) {
            await publishAuthState(false);
            return;
        }
        try {
            await getClient();
            await publishAuthState(true);
        }
        catch (error) {
            if (isPermanentAuthFailure(error)) {
                await revokeAuthentication();
            }
            throw error;
        }
    }
    async function isAuthenticated() {
        return Boolean((await loadGeminiCredential(config.dshHome))?.refreshToken);
    }
    async function logout() {
        invalidateModelDiscovery();
        await clearGeminiCredential(config.dshHome);
        client = undefined;
        projectCache = undefined;
        await publishAuthState(false);
    }
    async function dispose() {
        clearAuthStateRetry();
        if (pending)
            await closeServer(pending.server);
        pending = undefined;
        client = undefined;
        projectCache = undefined;
        invalidateModelDiscovery();
    }
    return { getProjectId, requestJson, requestStream, getAccessToken, listModels, startGeminiLogin, initialize, logout, dispose, isAuthenticated, ensureGeminiCodeAssistSetup };
}
/**
 * Convert Gemini Code Assist streaming events into DSH stream chunks.
 *
 * @param transport - authenticated Gemini transport.
 * @param options - provider-neutral DSH generation request.
 * @returns an async stream ending with exactly one finish chunk.
 */
export async function* streamGemini(transport, options) {
    if (options.signal?.aborted)
        throw new DOMException('The operation was aborted', 'AbortError');
    if (options.reasoningEffort !== undefined)
        throw geminiError('Gemini reasoning effort is not supported', 'UNSUPPORTED_REASONING_EFFORT');
    const project = await transport.getProjectId(options.signal);
    const request = toGenerateRequest(options, project);
    const stream = await transport.requestStream({
        url: getMethodUrl('streamGenerateContent'),
        method: 'POST',
        params: { alt: 'sse' },
        headers: attributionHeaders(),
        body: JSON.stringify(request),
        signal: options.signal,
    });
    let textIndex;
    let completeText = '';
    let nextIndex = 0;
    let hasToolCall = false;
    let usageEmitted = false;
    for await (const event of parseSse(stream)) {
        if (options.signal?.aborted)
            throw new DOMException('The operation was aborted', 'AbortError');
        if (event.error)
            throw geminiError('Gemini stream returned an error event', 'GEMINI_STREAM_ERROR');
        const response = responseFromEvent(event);
        if (!response)
            continue;
        const parts = responseParts(response);
        for (const part of parts) {
            if (typeof part.text === 'string') {
                if (textIndex === undefined) {
                    textIndex = nextIndex++;
                    yield { type: 'block-start', index: textIndex, blockType: 'text' };
                }
                completeText += part.text;
                yield { type: 'text-delta', index: textIndex, text: part.text };
            }
            const functionCall = part.functionCall;
            if (typeof functionCall === 'object' && functionCall !== null) {
                const call = functionCall;
                const name = typeof call.name === 'string' ? call.name : 'unknown';
                const args = call.args ?? {};
                const id = ToolCallId(randomUUID());
                const index = nextIndex++;
                const argumentsJson = JSON.stringify(args);
                hasToolCall = true;
                yield { type: 'block-start', index, blockType: 'tool-call' };
                yield { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson };
                yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } };
            }
        }
        const usage = response.usageMetadata;
        if (!usageEmitted && typeof usage === 'object' && usage !== null) {
            const metadata = usage;
            yield { type: 'usage', usage: { inputTokens: typeof metadata.promptTokenCount === 'number' ? metadata.promptTokenCount : 0, outputTokens: typeof metadata.candidatesTokenCount === 'number' ? metadata.candidatesTokenCount : 0 } };
            usageEmitted = true;
        }
    }
    if (textIndex !== undefined)
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: completeText } };
    if (!usageEmitted)
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
    yield { type: 'finish', reason: { kind: hasToolCall ? 'tool-calls' : 'stop' } };
}
/** Convert a remote Gemini model ID into a readable selector label without changing the request ID. */
function formatGeminiModelName(id) {
    const clean = id.replace(/^models\//, '');
    return clean.split('-').map(part => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)).join(' ');
}
/**
 * DSH adapter for the Gemini CLI Code Assist route.
 */
export class GeminiCliAdapter extends LlmAdapter {
    transport;
    constructor(transport) {
        super();
        this.transport = transport;
    }
    /**
     * Stream one DSH request through Gemini Code Assist.
     *
     * @param options - provider-neutral model request.
     * @returns translated DSH stream chunks.
     */
    stream(options) {
        return streamGemini(this.transport, options);
    }
    /**
     * Return the configured route's currently selected project metadata.
     *
     * @param provider - registered provider route.
     * @returns provider/model descriptor.
     */
    async resolveModel(provider, model) {
        return { provider, id: model, name: model };
    }
    /**
     * Keep model discovery advisory; the DSH configuration supplies the model ID.
     *
     * @param provider - provider route being queried.
     * @returns no fabricated model IDs.
     */
    async listModels(provider) {
        if (provider !== 'gemini-cli-oauth')
            return [];
        const models = await this.transport.listModels();
        return models.map(id => ({ provider, id, name: formatGeminiModelName(id) }));
    }
}
//# sourceMappingURL=gemini.js.map