/**
 * Multi-Scope Access Control System
 * Manages memory isolation and access permissions.
 */

// ============================================================================
// Types & Configuration
// ============================================================================

export interface ScopeDefinition {
    description: string;
}

export interface ScopeConfig {
    default: string;
    definitions: Record<string, ScopeDefinition>;
    agentAccess: Record<string, string[]>;
}

export interface ScopeManager {
    getAccessibleScopes(agentId?: string): string[];
    getDefaultScope(agentId?: string): string;
    isAccessible(scope: string, agentId?: string): boolean;
    validateScope(scope: string): boolean;
    getAllScopes(): string[];
    getScopeDefinition(scope: string): ScopeDefinition | undefined;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
    default: "global",
    definitions: {
        global: { description: "Shared knowledge across all agents" },
    },
    agentAccess: {},
};

const SCOPE_PATTERNS = {
    GLOBAL: "global",
    AGENT: (agentId: string) => `agent:${agentId}`,
    CUSTOM: (name: string) => `custom:${name}`,
    PROJECT: (projectId: string) => `project:${projectId}`,
    USER: (userId: string) => `user:${userId}`,
};

// ============================================================================
// Scope Manager Implementation
// ============================================================================

export class MemoryScopeManager implements ScopeManager {
    private config: ScopeConfig;

    constructor(config: Partial<ScopeConfig> = {}) {
        this.config = {
            default: config.default || DEFAULT_SCOPE_CONFIG.default,
            definitions: {
                ...DEFAULT_SCOPE_CONFIG.definitions,
                ...config.definitions,
            },
            agentAccess: {
                ...DEFAULT_SCOPE_CONFIG.agentAccess,
                ...config.agentAccess,
            },
        };

        if (!this.config.definitions.global) {
            this.config.definitions.global = { description: "Shared knowledge across all agents" };
        }

        this.validateConfiguration();
    }

    private validateConfiguration(): void {
        if (!this.config.definitions[this.config.default]) {
            throw new Error(`Default scope '${this.config.default}' not found in definitions`);
        }

        for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
            for (const scope of scopes) {
                if (!this.config.definitions[scope] && !this.isBuiltInScope(scope)) {
                    console.warn(`Agent '${agentId}' has access to undefined scope '${scope}'`);
                }
            }
        }
    }

    private isBuiltInScope(scope: string): boolean {
        return (
            scope === "global" ||
            scope.startsWith("agent:") ||
            scope.startsWith("custom:") ||
            scope.startsWith("project:") ||
            scope.startsWith("user:")
        );
    }

    getAccessibleScopes(agentId?: string): string[] {
        if (!agentId) return this.getAllScopes();

        const explicitAccess = this.config.agentAccess[agentId];
        if (explicitAccess) return explicitAccess;

        const defaultScopes = ["global"];
        const agentScope = SCOPE_PATTERNS.AGENT(agentId);

        if (this.config.definitions[agentScope] || this.isBuiltInScope(agentScope)) {
            defaultScopes.push(agentScope);
        }

        return defaultScopes;
    }

    getDefaultScope(agentId?: string): string {
        if (!agentId) return this.config.default;

        const agentScope = SCOPE_PATTERNS.AGENT(agentId);
        const accessibleScopes = this.getAccessibleScopes(agentId);

        if (accessibleScopes.includes(agentScope)) {
            return agentScope;
        }

        return this.config.default;
    }

    isAccessible(scope: string, agentId?: string): boolean {
        if (!agentId) return this.validateScope(scope);
        const accessibleScopes = this.getAccessibleScopes(agentId);
        return accessibleScopes.includes(scope);
    }

    validateScope(scope: string): boolean {
        if (!scope || typeof scope !== "string" || scope.trim().length === 0) return false;
        const trimmed = scope.trim();
        return this.config.definitions[trimmed] !== undefined || this.isBuiltInScope(trimmed);
    }

    getAllScopes(): string[] {
        return Object.keys(this.config.definitions);
    }

    getScopeDefinition(scope: string): ScopeDefinition | undefined {
        return this.config.definitions[scope];
    }

    getStats(): {
        totalScopes: number;
        agentsWithCustomAccess: number;
        scopesByType: Record<string, number>;
    } {
        const scopes = this.getAllScopes();
        const scopesByType: Record<string, number> = {
            global: 0, agent: 0, custom: 0, project: 0, user: 0, other: 0,
        };

        for (const scope of scopes) {
            if (scope === "global") scopesByType.global++;
            else if (scope.startsWith("agent:")) scopesByType.agent++;
            else if (scope.startsWith("custom:")) scopesByType.custom++;
            else if (scope.startsWith("project:")) scopesByType.project++;
            else if (scope.startsWith("user:")) scopesByType.user++;
            else scopesByType.other++;
        }

        return {
            totalScopes: scopes.length,
            agentsWithCustomAccess: Object.keys(this.config.agentAccess).length,
            scopesByType,
        };
    }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createScopeManager(config?: Partial<ScopeConfig>): MemoryScopeManager {
    return new MemoryScopeManager(config || {});
}
