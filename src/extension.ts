// VS Code Extension Entry Point
// Registers Kiro as a Language Model Chat Provider for GitHub Copilot

import * as vscode from "vscode";
import { KiroAuthManager } from "./auth";
import { KiroChatProvider } from "./provider";
import { showKiroUsage } from "./usage";

let provider: KiroChatProvider;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Kiro Provider");
  outputChannel.appendLine("[Kiro] Activating extension...");

  // Initialize auth manager
  const authManager = new KiroAuthManager(context);
  await authManager.initialize();

  // Create the chat provider
  provider = new KiroChatProvider(authManager, outputChannel, context);

  // Register with VS Code Language Model API
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("kiro", provider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilot-provider-kiro.login", async () => {
      try {
        await authManager.login();
        provider.refreshModelPicker();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Kiro login failed: ${msg}`);
      }
    }),

    vscode.commands.registerCommand("copilot-provider-kiro.logout", async () => {
      await authManager.logout();
      provider.refreshModelPicker();
    }),

    vscode.commands.registerCommand("copilot-provider-kiro.status", () => {
      const authenticated = authManager.isAuthenticated();
      const creds = authManager.getCredentials();
      if (authenticated && creds) {
        const expiresIn = Math.round((creds.expires - Date.now()) / 60000);
        vscode.window.showInformationMessage(
          `Kiro: Connected (${creds.authMethod}, region: ${creds.region}, expires in ${expiresIn} min)`
        );
      } else {
        vscode.window.showWarningMessage("Kiro: Not authenticated. Run 'Kiro: Login' to connect.");
      }
    }),

    vscode.commands.registerCommand("copilot-provider-kiro.usage", async () => {
      const creds = authManager.getCredentials();
      if (!creds) {
        vscode.window.showWarningMessage("Kiro: Not authenticated. Run 'Kiro: Login' first.");
        return;
      }
      await showKiroUsage(creds, outputChannel);
    }),
  );

  // Activate Copilot Chat and refresh model picker
  await activateCopilotChat();
  provider.refreshModelPicker();

  if (authManager.isAuthenticated()) {
    const creds = authManager.getCredentials()!;
    outputChannel.appendLine(`[Kiro] Auto-detected credentials: ${creds.authMethod}, region=${creds.region}`);
    outputChannel.appendLine("[Kiro] Models registered in Copilot Chat model picker.");
  } else {
    outputChannel.appendLine("[Kiro] No credentials found. Use 'Kiro: Login' to authenticate.");
  }

  outputChannel.appendLine("[Kiro] Extension activated.");
}

async function activateCopilotChat(): Promise<void> {
  try {
    await vscode.extensions.getExtension("github.copilot-chat")?.activate();
  } catch (error) {
    outputChannel.appendLine(`[Kiro] Copilot Chat activation unavailable: ${error}`);
  }
}

export async function deactivate() {
  await provider?.prepareForDeactivate();
  outputChannel?.appendLine("[Kiro] Extension deactivated.");
}
