// Message transformation: converts VS Code LanguageModelChatRequestMessage to Kiro API format

import * as vscode from "vscode";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}

export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}

export interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: {
    toolResults?: KiroToolResult[];
    tools?: KiroToolSpec[];
  };
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  profileArn?: string;
  agentMode?: string;
}

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Convert VS Code LanguageModelChatRequestMessage array to Kiro history + current message.
 */
export function transformMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  kiroModelId: string,
): { history: KiroHistoryEntry[]; currentContent: string; currentToolResults?: KiroToolResult[] } {
  const history: KiroHistoryEntry[] = [];

  if (messages.length === 0) {
    return { history: [], currentContent: "" };
  }

  // System role constant (not exported from vscode types but value is 3)
  const SYSTEM_ROLE = 3;

  // Gather system prompt (if any) and build history
  let systemPrompt = "";
  const lastIdx = messages.length - 1;

  for (let i = 0; i <= lastIdx; i++) {
    const msg = messages[i];

    // System messages get prepended to the first user message
    if ((msg.role as number) === SYSTEM_ROLE) {
      systemPrompt += extractText(msg) + "\n\n";
      continue;
    }

    // For the last user message, it becomes currentContent
    if (i === lastIdx && msg.role === vscode.LanguageModelChatMessageRole.User) {
      break;
    }

    if (msg.role === vscode.LanguageModelChatMessageRole.User) {
      const content = extractText(msg);
      const toolResults = extractToolResults(msg);
      const uim: KiroUserInputMessage = {
        content: sanitizeSurrogates(content || (toolResults.length > 0 ? "Tool results provided." : "")),
        modelId: kiroModelId,
        origin: "KIRO_CLI",
        ...(toolResults.length > 0 ? { userInputMessageContext: { toolResults } } : {}),
      };

      // Merge consecutive user messages
      const lastEntry = history[history.length - 1];
      if (lastEntry?.userInputMessage && !lastEntry.assistantResponseMessage) {
        lastEntry.userInputMessage.content += `\n\n${uim.content}`;
        if (uim.userInputMessageContext?.toolResults) {
          if (!lastEntry.userInputMessage.userInputMessageContext) {
            lastEntry.userInputMessage.userInputMessageContext = {};
          }
          lastEntry.userInputMessage.userInputMessageContext.toolResults = [
            ...(lastEntry.userInputMessage.userInputMessageContext.toolResults || []),
            ...uim.userInputMessageContext.toolResults,
          ];
        }
      } else {
        history.push({ userInputMessage: uim });
      }
    } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const content = extractText(msg);
      const toolCalls = extractToolCalls(msg);

      if (content || toolCalls.length > 0) {
        history.push({
          assistantResponseMessage: {
            content,
            ...(toolCalls.length > 0 ? { toolUses: toolCalls } : {}),
          },
        });
      }
    }
  }

  // Build current content from last message
  const lastMsg = messages[lastIdx];
  let currentContent = extractText(lastMsg);
  const currentToolResults = extractToolResults(lastMsg);

  // Prepend system prompt to first user message content
  if (systemPrompt) {
    if (history.length > 0 && history[0].userInputMessage) {
      history[0].userInputMessage.content = systemPrompt + history[0].userInputMessage.content;
    } else {
      currentContent = systemPrompt + currentContent;
    }
  }

  return {
    history,
    currentContent: sanitizeSurrogates(currentContent || (currentToolResults.length > 0 ? "Tool results provided." : "Please continue.")),
    ...(currentToolResults.length > 0 ? { currentToolResults } : {}),
  };
}

function extractText(msg: vscode.LanguageModelChatRequestMessage): string {
  const parts: string[] = [];
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    }
  }
  return parts.join("");
}

function extractToolCalls(msg: vscode.LanguageModelChatRequestMessage): KiroToolUse[] {
  const calls: KiroToolUse[] = [];
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      calls.push({
        name: part.name,
        toolUseId: part.callId,
        input: part.input as Record<string, unknown>,
      });
    }
  }
  return calls;
}

function extractToolResults(msg: vscode.LanguageModelChatRequestMessage): KiroToolResult[] {
  const results: KiroToolResult[] = [];
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelToolResultPart) {
      const textContent = part.content
        .filter((c): c is vscode.LanguageModelTextPart => c instanceof vscode.LanguageModelTextPart)
        .map((c) => c.value)
        .join("");
      results.push({
        content: [{ text: textContent }],
        status: "success",
        toolUseId: part.callId,
      });
    }
  }
  return results;
}

/**
 * Build the full Kiro API request from VS Code messages.
 */
export function buildKiroRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  modelId: string,
  kiroModelId: string,
  conversationId: string,
  profileArn?: string,
  tools?: KiroToolSpec[],
  thinkingBudget?: number,
): KiroRequest {
  const { history, currentContent, currentToolResults } = transformMessages(messages, kiroModelId);

  // Inject thinking mode config into the content (prepended to first user message via system prompt path)
  let effectiveContent = currentContent;
  if (thinkingBudget && thinkingBudget > 0) {
    const thinkingPrefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${thinkingBudget}</max_thinking_length>\n`;
    // If history has entries, inject into first history user message
    if (history.length > 0 && history[0].userInputMessage) {
      history[0].userInputMessage.content = thinkingPrefix + history[0].userInputMessage.content;
    } else {
      effectiveContent = thinkingPrefix + effectiveContent;
    }
  }

  const request: KiroRequest = {
    conversationState: {
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      conversationId,
      currentMessage: {
        userInputMessage: {
          content: effectiveContent,
          modelId: kiroModelId,
          origin: "KIRO_CLI",
          ...(tools || currentToolResults
            ? {
                userInputMessageContext: {
                  ...(tools && tools.length > 0 ? { tools } : {}),
                  ...(currentToolResults && currentToolResults.length > 0 ? { toolResults: currentToolResults } : {}),
                },
              }
            : {}),
        },
      },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
    agentMode: "vibe",
  };

  return request;
}
