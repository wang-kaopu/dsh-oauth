export interface CodexCredential {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: number;
    accountId: string;
}
export interface GeminiCredential {
    accessToken?: string;
    refreshToken: string;
    expiresAt?: number;
    projectId?: string;
}
export interface CredentialDocument {
    version: 1;
    codex?: CodexCredential;
    gemini?: GeminiCredential;
    codexRouteOwned?: true;
}
/**
 * Read whether the Codex settings route was created by this plugin.
 *
 * @param dshHome - optional explicit DSH home used by tests or an embedding host.
 * @returns true only when the ownership marker is present.
 */
export declare function loadCodexRouteOwnership(dshHome?: string): Promise<boolean>;
/**
 * Persist or clear the Codex settings route ownership marker.
 *
 * @param owned - whether the plugin currently owns the route it created.
 * @param dshHome - optional explicit DSH home used by tests or an embedding host.
 */
export declare function setCodexRouteOwnership(owned: boolean, dshHome?: string): Promise<void>;
/**
 * Load the complete OAuth credential document.
 *
 * @param dshHome - optional explicit DSH home used by tests or an embedding host.
 * @returns the stored document, or an empty version-one document when absent.
 */
export declare function loadDocument(dshHome?: string): Promise<CredentialDocument>;
/**
 * Atomically replace the complete OAuth credential document.
 *
 * @param document - document to persist.
 * @param dshHome - optional explicit DSH home.
 */
export declare function saveDocument(document: CredentialDocument, dshHome?: string): Promise<void>;
/**
 * Load the stored Codex credential.
 *
 * @param dshHome - optional explicit DSH home.
 * @returns the Codex credential, if authenticated.
 */
export declare function loadCodexCredential(dshHome?: string): Promise<CodexCredential | undefined>;
/**
 * Save the Codex credential without disturbing the Gemini credential.
 *
 * @param credential - refreshed or newly exchanged Codex credential.
 * @param dshHome - optional explicit DSH home.
 */
export declare function saveCodexCredential(credential: CodexCredential, dshHome?: string): Promise<void>;
/**
 * Remove the Codex credential.
 *
 * @param dshHome - optional explicit DSH home.
 */
export declare function clearCodexCredential(dshHome?: string): Promise<void>;
/**
 * Load the stored Gemini credential.
 *
 * @param dshHome - optional explicit DSH home.
 * @returns the Gemini credential, if authenticated.
 */
export declare function loadGeminiCredential(dshHome?: string): Promise<GeminiCredential | undefined>;
/**
 * Save the Gemini credential without disturbing the Codex credential.
 *
 * @param credential - OAuth or Code Assist credential to persist.
 * @param dshHome - optional explicit DSH home.
 */
export declare function saveGeminiCredential(credential: GeminiCredential, dshHome?: string): Promise<void>;
/**
 * Remove the Gemini credential.
 *
 * @param dshHome - optional explicit DSH home.
 */
export declare function clearGeminiCredential(dshHome?: string): Promise<void>;
//# sourceMappingURL=storage.d.ts.map