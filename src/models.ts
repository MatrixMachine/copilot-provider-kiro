// Kiro model definitions for VS Code Language Model Provider

import * as vscode from "vscode";

export interface KiroModel {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportedMediaTypes?: string[];
  reasoning?: boolean;
}

// --- Thinking Effort ---

export type ThinkingEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface ModelConfigurationOptions extends vscode.ProvideLanguageModelChatResponseOptions {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
}

/**
 * Build a configurationSchema for models that support thinking/reasoning.
 * This renders a dropdown in the Copilot Chat model picker (non-public API).
 */
export function buildThinkingEffortSchema() {
  return {
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking",
        enum: ["none", "low", "medium", "high", "xhigh"],
        enumItemLabels: ["None", "Low", "Medium", "High", "Max"],
        enumDescriptions: [
          "Disable thinking for faster responses",
          "Light thinking (~10K tokens)",
          "Standard thinking (~20K tokens)",
          "Deep thinking (~30K tokens)",
          "Maximum thinking (~50K tokens)",
        ],
        default: "medium",
        group: "navigation",
      },
    },
  } as const;
}

/**
 * Read the user-configured thinking effort from the model picker options.
 */
export function getConfiguredThinkingEffort(options: ModelConfigurationOptions): ThinkingEffort {
  const configured =
    options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;

  switch (configured) {
    case "none":
      return "none";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return "medium";
  }
}

/**
 * Map thinking effort to a token budget (matching pi-provider-kiro logic).
 */
export function getThinkingBudget(effort: ThinkingEffort): number {
  switch (effort) {
    case "xhigh":
      return 50000;
    case "high":
      return 30000;
    case "medium":
      return 20000;
    case "low":
      return 10000;
    case "none":
      return 0;
  }
}

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const CONFIG_SECTION = "copilot-provider-kiro";

// Valid Kiro model IDs - API accepts friendly names directly
export const KIRO_MODEL_IDS = new Set([
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.1",
  "minimax-m2.5",
  "glm-5",
  "qwen3-coder-next",
  "auto",
]);

export const kiroModels: KiroModel[] = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    family: "claude-opus",
    version: "4.8",
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: true,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    family: "claude-opus",
    version: "4.7",
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: true,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    family: "claude-opus",
    version: "4.6",
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: true,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    family: "claude-sonnet",
    version: "4.6",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: true,
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    family: "claude-sonnet",
    version: "4.5",
    maxInputTokens: 200000,
    maxOutputTokens: 65536,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: true,
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    family: "claude-sonnet",
    version: "4.0",
    maxInputTokens: 200000,
    maxOutputTokens: 65536,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: true,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    family: "claude-haiku",
    version: "4.5",
    maxInputTokens: 200000,
    maxOutputTokens: 65536,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: false,
  },
  {
    id: "deepseek-3-2",
    name: "DeepSeek 3.2",
    family: "deepseek",
    version: "3.2",
    maxInputTokens: 164000,
    maxOutputTokens: 8192,
    reasoning: true,
  },
  {
    id: "minimax-m2-5",
    name: "MiniMax M2.5",
    family: "minimax",
    version: "2.5",
    maxInputTokens: 196000,
    maxOutputTokens: 8192,
    reasoning: false,
  },
  {
    id: "minimax-m2-1",
    name: "MiniMax M2.1",
    family: "minimax",
    version: "2.1",
    maxInputTokens: 196000,
    maxOutputTokens: 8192,
    reasoning: false,
  },
  {
    id: "glm-5",
    name: "GLM 5",
    family: "glm",
    version: "5.0",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
    reasoning: true,
  },
  {
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    family: "qwen",
    version: "3.0",
    maxInputTokens: 256000,
    maxOutputTokens: 8192,
    reasoning: true,
  },
  {
    id: "kiro-auto",
    name: "Kiro Auto",
    family: "kiro-auto",
    version: "1.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    supportedMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    reasoning: true,
  },
];

/**
 * Convert pi model ID format (dashes) to kiro API format (dots).
 * e.g. "claude-opus-4-6" -> "claude-opus-4.6"
 */
export function resolveKiroModel(modelId: string): string {
  // Map alias back to actual Kiro API model ID
  if (modelId === "kiro-auto") return "auto";
  return modelId.replace(/(\d)-(\d)/g, "$1.$2");
}

/**
 * Resolve user-configured alias (display name) for a VS Code model ID.
 */
export function resolveModelAlias(modelId: string, defaultName: string): string {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const aliases = config.get<Record<string, string>>("modelAliases");
  const alias = aliases?.[modelId]?.trim();
  return alias || defaultName;
}

/**
 * Map an SSO/OIDC region to the Kiro API region.
 */
const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
}
