/**
 * Type declarations for OpenClaw Plugin SDK.
 * These types represent the minimal OpenClaw plugin API used by this plugin.
 * On the target Ubuntu VM, openclaw/plugin-sdk provides the real types at runtime.
 */

declare module "openclaw/plugin-sdk" {
    export interface ToolDefinition {
        name: string;
        label?: string;
        description: string;
        parameters: any;
        execute: (toolCallId: string, params: any) => Promise<ToolResult>;
    }

    export interface ToolResult {
        content: Array<{ type: string; text: string }>;
        details?: Record<string, unknown>;
    }

    export interface ToolRegistrationOptions {
        name?: string;
    }

    export interface ServiceDefinition {
        id: string;
        start: () => Promise<void>;
        stop: () => void;
    }

    export interface Logger {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        debug: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    }

    export interface CommandContext {
        senderId?: string;
        channel?: string;
        isAuthorizedSender?: boolean;
        args?: string;
        commandBody?: string;
        config?: unknown;
    }

    export interface CommandDefinition {
        name: string;
        description: string;
        acceptsArgs?: boolean;
        requireAuth?: boolean;
        handler: (ctx: CommandContext) => Promise<{ text: string }> | { text: string };
    }

    export interface OpenClawPluginApi {
        pluginConfig: unknown;
        logger: Logger;
        resolvePath: (path: string) => string;
        registerTool: (tool: ToolDefinition, options?: ToolRegistrationOptions) => void;
        registerService: (service: ServiceDefinition) => void;
        registerHook: (event: string, handler: (event: any) => Promise<void>) => void;
        registerCommand: (command: CommandDefinition) => void;
        on: (event: string, handler: (event: any, ctx?: any) => Promise<any>) => void;
    }

    /** Create a TypeBox enum schema from a readonly string array. */
    export function stringEnum<T extends readonly string[]>(values: T): any;
}
