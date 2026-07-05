// Kiro Language Model Chat Provider for VS Code Copilot
// Implements vscode.LanguageModelChatProvider to make Kiro models appear in Copilot Chat model picker

import * as vscode from "vscode";
import { UniversalEventStreamMarshaller } from "@smithy/core/event-streams";
import type { Message } from "@smithy/types";
import { type KiroAuthManager, getKiroCliCredentials, refreshViaKiroCli } from "./auth";
import { parseKiroEvent } from "./event-parser";
import {
  type KiroModel,
  type ModelConfigurationOptions,
  type ThinkingEffort,
  kiroModels,
  resolveApiRegion,
  resolveKiroModel,
  resolveModelAlias,
  buildThinkingEffortSchema,
  getConfiguredThinkingEffort,
  getThinkingBudget,
} from "./models";
import { type KiroToolSpec, buildKiroRequest } from "./transform";

const eventStreamMarshaller = new UniversalEventStreamMarshaller({
  utf8Encoder: (input: Uint8Array) => new TextDecoder().decode(input),
  utf8Decoder: (input: string) => new TextEncoder().encode(input),
});

// --- profileArn resolution ---
const profileArnCache = new Map<string, string>();

async function resolveProfileArn(accessToken: string, endpoint: string): Promise<string | undefined> {
  if (profileArnCache.has(endpoint)) return profileArnCache.get(endpoint);
  try {
    const ep = new URL(endpoint);
    ep.pathname = ep.pathname.replace(/\/generateAssistantResponse\/?$/, "/");
    ep.search = "";
    ep.hash = "";
    const r = await fetch(ep.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Authorization: `Bearer ${accessToken}`,
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
      },
      body: "{}",
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { profiles?: Array<{ arn?: string }> };
    const arn = j.profiles?.find((p) => p.arn)?.arn;
    if (arn) profileArnCache.set(endpoint, arn);
    return arn;
  } catch {
    return undefined;
  }
}

// --- Retry helpers ---
function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

function isCapacityError(text: string): boolean {
  return text.includes("INSUFFICIENT_MODEL_CAPACITY");
}

function isTooBigError(status: number, text: string): boolean {
  return status === 413 || (status === 400 && (
    text.includes("CONTENT_LENGTH_EXCEEDS_THRESHOLD") ||
    text.includes("Input is too long") ||
    text.includes("Improperly formed")
  ));
}

interface ToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

/**
 * Kiro Chat Provider — implements vscode.LanguageModelChatProvider so
 * Kiro models appear directly in the Copilot Chat model picker.
 */
export class KiroChatProvider implements vscode.LanguageModelChatProvider {
  private readonly authManager: KiroAuthManager;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private isActive = true;

  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  constructor(
    authManager: KiroAuthManager,
    outputChannel: vscode.OutputChannel,
    context: vscode.ExtensionContext,
  ) {
    this.authManager = authManager;
    this.outputChannel = outputChannel;

    context.subscriptions.push(this.onDidChangeEmitter);
  }

  refreshModelPicker(): void {
    this.onDidChangeEmitter.fire();
  }

  async prepareForDeactivate(): Promise<void> {
    this.isActive = false;
    this.onDidChangeEmitter.fire();
    try {
      await vscode.lm.selectChatModels({ vendor: "kiro" });
    } catch { /* ignore */ }
  }

  // ---- LanguageModelChatProvider ----

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (!this.isActive) return [];

    const hasCredentials = this.authManager.isAuthenticated();

    return kiroModels.map((model) => ({
      id: model.id,
      name: resolveModelAlias(model.id, model.name),
      family: model.family,
      version: model.version,
      detail: hasCredentials ? "Kiro (Free)" : "Kiro: Login required",
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      isUserSelectable: true,
      isBYOK: true,
      capabilities: {
        toolCalling: true,
        imageInput: !!model.supportedMediaTypes?.length,
      },
      ...(model.reasoning ? { configurationSchema: buildThinkingEffortSchema() } : {}),
    }));
  }

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let accessToken = await this.authManager.getAccessToken();
    if (!accessToken) {
      throw new Error("Kiro credentials not available. Run 'Kiro: Login' command first.");
    }

    const credentials = this.authManager.getCredentials()!;
    const region = resolveApiRegion(credentials.region);
    const endpoint = `https://q.${region}.amazonaws.com/generateAssistantResponse`;
    const kiroModelId = resolveKiroModel(modelInfo.id);
    const conversationId = crypto.randomUUID();

    let profileArn = credentials.profileArn || await resolveProfileArn(accessToken, endpoint);

    // Convert tools from options
    let tools: KiroToolSpec[] | undefined;
    if (options.tools && options.tools.length > 0) {
      tools = options.tools.map((t) => ({
        toolSpecification: {
          name: t.name,
          description: t.description || "",
          inputSchema: { json: t.inputSchema as Record<string, unknown> || { type: "object", properties: {} } },
        },
      }));
    }

    // Resolve thinking effort from model picker configuration
    const modelDef = kiroModels.find((m) => m.id === modelInfo.id);
    const thinkingEffort = modelDef?.reasoning
      ? getConfiguredThinkingEffort(options as ModelConfigurationOptions)
      : "none";
    const thinkingBudget = getThinkingBudget(thinkingEffort);

    this.outputChannel.appendLine(`[Kiro] Thinking: effort=${thinkingEffort}, budget=${thinkingBudget}`);

    // Convert messages to Kiro format
    const request = buildKiroRequest(messages, modelInfo.id, kiroModelId, conversationId, profileArn, tools, thinkingBudget);

    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount <= maxRetries) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();

      const mid = crypto.randomUUID().replace(/-/g, "");
      const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;

      this.outputChannel.appendLine(`[Kiro] Request → ${kiroModelId} (attempt ${retryCount})`);

      const abortController = new AbortController();
      const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.0",
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
            "x-amzn-codewhisperer-optout": "true",
            "amz-sdk-invocation-id": crypto.randomUUID(),
            "amz-sdk-request": "attempt=1; max=1",
            "x-amzn-kiro-agent-mode": "vibe",
            "x-amz-user-agent": ua,
            "user-agent": ua,
          },
          body: JSON.stringify(request),
          signal: abortController.signal,
        });
      } finally {
        cancelDisposable.dispose();
      }

      if (!response.ok) {
        let errText = "";
        try { errText = await response.text(); } catch { /* ignore */ }
        this.outputChannel.appendLine(`[Kiro] Error: ${response.status} ${errText.substring(0, 200)}`);

        // Capacity errors
        if (isCapacityError(errText) && retryCount < maxRetries) {
          retryCount++;
          await this.delay(exponentialBackoff(retryCount - 1, 5000, 30000), token);
          continue;
        }

        // 403 — refresh token
        if (response.status === 403 && retryCount < maxRetries) {
          retryCount++;
          const freshCreds = getKiroCliCredentials() ?? refreshViaKiroCli();
          if (freshCreds?.access) accessToken = freshCreds.access;
          profileArnCache.delete(endpoint);
          profileArn = freshCreds?.profileArn || await resolveProfileArn(accessToken, endpoint);
          if (profileArn) request.profileArn = profileArn;
          await this.delay(exponentialBackoff(retryCount - 1, 500, 10000), token);
          continue;
        }

        if (isTooBigError(response.status, errText)) {
          throw new Error(`Kiro API: context too large (${response.status})`);
        }

        throw new Error(`Kiro API error: ${response.status} ${response.statusText}`);
      }

      // Stream the response
      if (!response.body) throw new Error("No response body");
      await this.processStream(response.body, progress, token);
      this.outputChannel.appendLine(`[Kiro] Response complete.`);
      return;
    }

    throw new Error("Kiro API: max retries exceeded");
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    // Simple estimation: ~4 chars per token
    const content = typeof text === "string" ? text : this.extractTextFromRequestMessage(text);
    return Math.ceil(content.length / 4);
  }

  private extractTextFromRequestMessage(msg: vscode.LanguageModelChatRequestMessage): string {
    const parts: string[] = [];
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push(part.value);
      }
    }
    return parts.join("");
  }

  private async processStream(
    body: ReadableStream<Uint8Array>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const bodyReader = body.getReader();
    let currentToolCall: ToolCallState | null = null;

    const flushToolCall = () => {
      if (!currentToolCall) return;
      let args: Record<string, unknown>;
      try {
        args = currentToolCall.input.trim() ? JSON.parse(currentToolCall.input) : {};
      } catch {
        this.outputChannel.appendLine(`[Kiro] Failed to parse tool args for "${currentToolCall.name}"`);
        args = {};
      }
      progress.report(new vscode.LanguageModelToolCallPart(currentToolCall.toolUseId, currentToolCall.name, args));
      currentToolCall = null;
    };

    const bodyIterable: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const { done, value } = await bodyReader.read();
            if (done) return;
            yield value;
          }
        } finally {
          bodyReader.releaseLock();
        }
      },
    };

    const utf8Decoder = new TextDecoder();
    const eventStream = eventStreamMarshaller.deserialize(bodyIterable, async (event: Record<string, Message>) => {
      const key = Object.keys(event)[0]!;
      const msg = event[key]!;
      const parsed = JSON.parse(utf8Decoder.decode(msg.body)) as Record<string, unknown>;
      return { [key]: parsed } as Record<string, unknown>;
    });

    const iterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>;
    let streamError: string | null = null;

    // Thinking tag stripping state
    let inThinking = false;
    let activeCloseTag = "</thinking>";
    let pendingText = "";
    const THINKING_TAGS = [
      { open: "<thinking>", close: "</thinking>" },
      { open: "<think>", close: "</think>" },
      { open: "<reasoning>", close: "</reasoning>" },
    ];

    while (true) {
      if (token.isCancellationRequested) {
        void bodyReader.cancel().catch(() => {});
        break;
      }

      let iterResult: IteratorResult<Record<string, unknown>>;
      try {
        iterResult = await iterator.next();
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
        break;
      }

      const { done, value } = iterResult;
      if (done) break;

      const eventPayload = Object.values(value as Record<string, unknown>)[0] as Record<string, unknown>;
      const event = parseKiroEvent(eventPayload);
      if (!event) continue;

      switch (event.type) {
        case "content": {
          pendingText += event.data;

          while (pendingText.length > 0) {
            if (!inThinking) {
              let foundOpen = false;
              for (const tag of THINKING_TAGS) {
                const idx = pendingText.indexOf(tag.open);
                if (idx !== -1) {
                  if (idx > 0) {
                    progress.report(new vscode.LanguageModelTextPart(pendingText.substring(0, idx)));
                  }
                  pendingText = pendingText.substring(idx + tag.open.length);
                  inThinking = true;
                  activeCloseTag = tag.close;
                  foundOpen = true;
                  break;
                }
              }
              if (!foundOpen) {
                // Check partial tag at end
                let maxPartial = 0;
                for (const tag of THINKING_TAGS) {
                  for (let len = 1; len < tag.open.length && len <= pendingText.length; len++) {
                    if (pendingText.endsWith(tag.open.substring(0, len))) {
                      maxPartial = Math.max(maxPartial, len);
                    }
                  }
                }
                const safe = pendingText.length - maxPartial;
                if (safe > 0) {
                  progress.report(new vscode.LanguageModelTextPart(pendingText.substring(0, safe)));
                  pendingText = pendingText.substring(safe);
                }
                break;
              }
            } else {
              const closeIdx = pendingText.indexOf(activeCloseTag);
              if (closeIdx !== -1) {
                // Thinking content is discarded (or could be emitted as LanguageModelThinkingPart if available)
                pendingText = pendingText.substring(closeIdx + activeCloseTag.length);
                inThinking = false;
                if (pendingText.startsWith("\n\n")) pendingText = pendingText.substring(2);
              } else {
                pendingText = "";
                break;
              }
            }
          }
          break;
        }
        case "toolUse": {
          const tc = event.data;
          if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
            flushToolCall();
            currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
          }
          currentToolCall.input += tc.input || "";
          if (tc.stop) flushToolCall();
          break;
        }
        case "toolUseInput": {
          if (currentToolCall) currentToolCall.input += event.data.input || "";
          break;
        }
        case "toolUseStop": {
          if (event.data.stop) flushToolCall();
          break;
        }
        case "error": {
          const errMsg = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
          streamError = errMsg;
          void bodyReader.cancel().catch(() => {});
          break;
        }
        case "usage":
        case "contextUsage":
        case "followupPrompt":
          break;
      }

      if (streamError) break;
    }

    // Flush remaining text
    if (pendingText && !inThinking) {
      progress.report(new vscode.LanguageModelTextPart(pendingText));
    }
    flushToolCall();

    if (streamError) {
      throw new Error(`Kiro stream error: ${streamError}`);
    }
  }

  private delay(ms: number, token: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const disposable = token.onCancellationRequested(() => {
        clearTimeout(timer);
        disposable.dispose();
        reject(new vscode.CancellationError());
      });
    });
  }
}
