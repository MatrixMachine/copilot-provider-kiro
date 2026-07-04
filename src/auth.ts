// Authentication module for Kiro credentials
// Reads from kiro-cli SQLite DB and Kiro IDE token files

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

export type KiroAuthMethod = "idc" | "desktop";

export interface KiroCredentials {
  access: string;
  refresh: string;
  expires: number;
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: KiroAuthMethod;
  profileArn?: string;
}

export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

// --- Kiro IDE Credentials ---

const SSO_CACHE_DIR = join(homedir(), ".aws", "sso", "cache");
const KIRO_IDE_TOKEN_PATH = join(SSO_CACHE_DIR, "kiro-auth-token.json");

interface KiroIdeTokenFile {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  region?: string;
  clientIdHash?: string;
  authMethod?: string;
}

interface KiroIdeClientFile {
  clientId: string;
  clientSecret: string;
}

function readKiroIdeToken(allowExpired: boolean): KiroCredentials | undefined {
  try {
    if (!existsSync(KIRO_IDE_TOKEN_PATH)) return undefined;

    const tokenData = JSON.parse(readFileSync(KIRO_IDE_TOKEN_PATH, "utf-8")) as KiroIdeTokenFile;
    if (!tokenData.accessToken || !tokenData.refreshToken) return undefined;

    const expiresAt = new Date(tokenData.expiresAt).getTime();
    if (!allowExpired && Date.now() >= expiresAt - 2 * 60 * 1000) return undefined;

    const region = tokenData.region ?? "us-east-1";

    let clientId = "";
    let clientSecret = "";
    if (tokenData.clientIdHash) {
      const regPath = join(SSO_CACHE_DIR, `${tokenData.clientIdHash}.json`);
      if (existsSync(regPath)) {
        try {
          const reg = JSON.parse(readFileSync(regPath, "utf-8")) as KiroIdeClientFile;
          clientId = reg.clientId ?? "";
          clientSecret = reg.clientSecret ?? "";
        } catch { /* ignore */ }
      }
    }

    return {
      refresh: `${tokenData.refreshToken}|${clientId}|${clientSecret}|idc`,
      access: tokenData.accessToken,
      expires: expiresAt - 2 * 60 * 1000,
      clientId,
      clientSecret,
      region,
      authMethod: "idc",
    };
  } catch {
    return undefined;
  }
}

export function getKiroIdeCredentials(): KiroCredentials | undefined {
  return readKiroIdeToken(false);
}

export function getKiroIdeCredentialsAllowExpired(): KiroCredentials | undefined {
  return readKiroIdeToken(true);
}

// --- Kiro CLI Credentials ---

function getKiroCliDbPath(): string | undefined {
  const p = platform();
  let dbPath: string;
  if (p === "win32")
    dbPath = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
  else if (p === "darwin")
    dbPath = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  else
    dbPath = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
  return existsSync(dbPath) ? dbPath : undefined;
}

function queryKiroCliDb(dbPath: string, sql: string): string | undefined {
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

function tryKiroCliToken(
  dbPath: string,
  tokenKey: string,
  authMethod: KiroAuthMethod,
  allowExpired = false,
): KiroCredentials | undefined {
  const tokenResult = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${tokenKey}'`);
  if (!tokenResult) return undefined;
  const rows = JSON.parse(tokenResult) as Array<{ value: string }>;
  if (!rows[0]?.value) return undefined;
  const tokenData = JSON.parse(rows[0].value);
  if (!tokenData.access_token || !tokenData.refresh_token) return undefined;
  let expiresAt = Date.now() + 3600000;
  if (tokenData.expires_at) expiresAt = new Date(tokenData.expires_at).getTime();
  if (!allowExpired && Date.now() >= expiresAt - 2 * 60 * 1000) return undefined;
  const region = tokenData.region || "us-east-1";

  if (authMethod === "desktop") {
    return {
      refresh: `${tokenData.refresh_token}|desktop`,
      access: tokenData.access_token,
      expires: expiresAt,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
      profileArn: tokenData.profile_arn || tokenData.profileArn,
    };
  }

  let clientId = "";
  let clientSecret = "";
  const keyPrefix = tokenKey.split(":")[0];
  const deviceResult = queryKiroCliDb(
    dbPath,
    `SELECT value FROM auth_kv WHERE key = '${keyPrefix}:odic:device-registration'`,
  );
  if (deviceResult) {
    try {
      const d = JSON.parse(JSON.parse(deviceResult)[0]?.value);
      clientId = d.client_id || d.clientId || "";
      clientSecret = d.client_secret || d.clientSecret || "";
    } catch { /* ignore */ }
  }
  return {
    refresh: `${tokenData.refresh_token}|${clientId}|${clientSecret}|idc`,
    access: tokenData.access_token,
    expires: expiresAt,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
  };
}

export function getKiroCliCredentials(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    const idcCreds = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc");
    if (idcCreds) return idcCreds;
    const desktopCreds = tryKiroCliToken(dbPath, "kirocli:social:token", "desktop");
    if (desktopCreds) return desktopCreds;
    return undefined;
  } catch {
    return undefined;
  }
}

export function getKiroCliCredentialsAllowExpired(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    const idcCreds = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc", true);
    if (idcCreds) return idcCreds;
    const desktopCreds = tryKiroCliToken(dbPath, "kirocli:social:token", "desktop", true);
    if (desktopCreds) return desktopCreds;
    return undefined;
  } catch {
    return undefined;
  }
}

export function getKiroCliSocialToken(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    return tryKiroCliToken(dbPath, "kirocli:social:token", "desktop");
  } catch {
    return undefined;
  }
}

export function refreshViaKiroCli(): KiroCredentials | undefined {
  try {
    execFileSync("kiro-cli", ["debug", "refresh-auth-token"], {
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return getKiroCliCredentials();
  } catch {
    return undefined;
  }
}

// --- Token Refresh ---

export async function refreshKiroToken(credentials: KiroCredentials): Promise<KiroCredentials> {
  // Layer 0: Kiro IDE token
  const ideCreds = getKiroIdeCredentials();
  if (ideCreds) return ideCreds;

  // Layer 1: Fresh kiro-cli token
  let preCheckCreds = getKiroCliSocialToken();
  if (!preCheckCreds) preCheckCreds = getKiroCliCredentials();
  if (preCheckCreds) return preCheckCreds;

  // Layer 2: Direct refresh
  try {
    return await refreshKiroTokenDirect(credentials);
  } catch (refreshError) {
    // Layer 3: Re-read kiro-cli DB
    const retryCreds = getKiroCliCredentials();
    if (retryCreds) return retryCreds;

    // Layer 4: Expired kiro-cli credentials with different refresh token
    const expiredCliCreds = getKiroCliCredentialsAllowExpired();
    if (expiredCliCreds && expiredCliCreds.refresh !== credentials.refresh) {
      try {
        return await refreshKiroTokenDirect(expiredCliCreds);
      } catch { /* continue */ }
    }

    // Layer 5: Use buffered expiry
    const EXPIRES_BUFFER_MS = 5 * 60 * 1000;
    const actualExpiry = credentials.expires + EXPIRES_BUFFER_MS;
    if (credentials.access && Date.now() < actualExpiry) {
      return { ...credentials, expires: actualExpiry };
    }

    throw refreshError;
  }
}

async function refreshKiroTokenDirect(credentials: KiroCredentials): Promise<KiroCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const authMethod = (parts[parts.length - 1] ?? "idc") as KiroAuthMethod;
  const region = credentials.region || "us-east-1";

  if (authMethod === "desktop") {
    const url = KIRO_DESKTOP_REFRESH_URL.replace("{region}", region);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "vscode-copilot-kiro" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
      profileArn?: string;
    };
    if (!data.accessToken) throw new Error("Desktop token refresh: missing accessToken");
    return {
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      access: data.accessToken,
      expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
      profileArn: data.profileArn || credentials.profileArn,
    };
  }

  // IDC auth method — SSO OIDC refresh
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  const ssoEndpoint = `https://oidc.${region}.amazonaws.com`;
  const response = await fetch(`${ssoEndpoint}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "vscode-copilot-kiro" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc`,
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
  };
}

// --- Device Code Login Flow ---

const IDC_PROBE_REGIONS = [
  "us-east-1", "eu-west-1", "eu-central-1", "us-east-2",
  "eu-west-2", "eu-west-3", "eu-north-1",
  "ap-southeast-1", "ap-northeast-1", "us-west-2",
];

interface DeviceAuth {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

async function tryRegisterAndAuthorize(
  startUrl: string,
  region: string,
): Promise<{ clientId: string; clientSecret: string; oidcEndpoint: string; devAuth: DeviceAuth } | null> {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;

  const regResp = await fetch(`${oidcEndpoint}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "vscode-copilot-kiro" },
    body: JSON.stringify({
      clientName: "vscode-copilot-kiro",
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });
  if (!regResp.ok) return null;
  const { clientId, clientSecret } = (await regResp.json()) as { clientId: string; clientSecret: string };

  const devResp = await fetch(`${oidcEndpoint}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "vscode-copilot-kiro" },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!devResp.ok) return null;

  return { clientId, clientSecret, oidcEndpoint, devAuth: (await devResp.json()) as DeviceAuth };
}

export async function loginWithDeviceCode(
  startUrl: string = BUILDER_ID_START_URL,
  token?: vscode.CancellationToken,
): Promise<KiroCredentials> {
  let result: Awaited<ReturnType<typeof tryRegisterAndAuthorize>> = null;
  let region = "us-east-1";

  if (startUrl === BUILDER_ID_START_URL) {
    result = await tryRegisterAndAuthorize(startUrl, "us-east-1");
  } else {
    // Probe regions for IAM Identity Center
    for (const r of IDC_PROBE_REGIONS) {
      result = await tryRegisterAndAuthorize(startUrl, r);
      if (result) {
        region = r;
        break;
      }
    }
  }

  if (!result) throw new Error("Device authorization failed. Check your start URL.");

  const { clientId, clientSecret, oidcEndpoint, devAuth } = result;

  // Open browser for user to authorize
  const opened = await vscode.env.openExternal(vscode.Uri.parse(devAuth.verificationUriComplete));
  if (!opened) {
    vscode.window.showInformationMessage(
      `Open this URL to login: ${devAuth.verificationUriComplete}\nCode: ${devAuth.userCode}`
    );
  }

  // Poll for token
  const deadline = Date.now() + (devAuth.expiresIn || 600) * 1000;
  let interval = (devAuth.interval || 5) * 1000;

  while (Date.now() < deadline) {
    if (token?.isCancellationRequested) throw new Error("Login cancelled");
    await new Promise((r) => setTimeout(r, interval));

    const tokResp = await fetch(`${oidcEndpoint}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "vscode-copilot-kiro" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode: devAuth.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const tokData = (await tokResp.json()) as {
      error?: string;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
    };

    switch (tokData.error) {
      case undefined:
        if (tokData.accessToken && tokData.refreshToken) {
          return {
            refresh: `${tokData.refreshToken}|${clientId}|${clientSecret}|idc`,
            access: tokData.accessToken,
            expires: Date.now() + (tokData.expiresIn || 3600) * 1000 - 5 * 60 * 1000,
            clientId,
            clientSecret,
            region,
            authMethod: "idc",
          };
        }
        break;
      case "authorization_pending":
        break;
      case "slow_down":
        interval += (devAuth.interval || 5) * 1000;
        break;
      default:
        throw new Error(`Authorization failed: ${tokData.error}`);
    }
  }
  throw new Error("Authorization timed out");
}

// --- Credential Manager ---

export class KiroAuthManager {
  private credentials: KiroCredentials | undefined;
  private secretStorageKey = "copilot-provider-kiro.credentials";

  constructor(private context: vscode.ExtensionContext) {}

  async initialize(): Promise<void> {
    // Try to load from secret storage
    const stored = await this.context.secrets.get(this.secretStorageKey);
    if (stored) {
      try {
        this.credentials = JSON.parse(stored) as KiroCredentials;
      } catch { /* ignore */ }
    }

    // If no stored credentials, try to find existing ones
    if (!this.credentials) {
      this.credentials = this.findExistingCredentials();
      if (this.credentials) {
        await this.saveCredentials(this.credentials);
      }
    }
  }

  private findExistingCredentials(): KiroCredentials | undefined {
    // 1. Kiro IDE token
    const ideCreds = getKiroIdeCredentials();
    if (ideCreds) return ideCreds;

    // 2. kiro-cli credentials
    const cliSocial = getKiroCliSocialToken();
    if (cliSocial) return cliSocial;

    const cliCreds = getKiroCliCredentials();
    if (cliCreds) return cliCreds;

    return undefined;
  }

  async getAccessToken(): Promise<string | undefined> {
    if (!this.credentials) return undefined;

    // Check if token needs refresh (5 min buffer)
    if (Date.now() >= this.credentials.expires - 2 * 60 * 1000) {
      try {
        this.credentials = await refreshKiroToken(this.credentials);
        await this.saveCredentials(this.credentials);
      } catch (error) {
        // Try to find fresh credentials from other sources
        const fresh = this.findExistingCredentials();
        if (fresh) {
          this.credentials = fresh;
          await this.saveCredentials(fresh);
        } else {
          return undefined;
        }
      }
    }

    return this.credentials.access;
  }

  getCredentials(): KiroCredentials | undefined {
    return this.credentials;
  }

  isAuthenticated(): boolean {
    return !!this.credentials?.access;
  }

  async login(): Promise<void> {
    // First check if we already have valid credentials
    const existing = this.findExistingCredentials();
    if (existing) {
      this.credentials = existing;
      await this.saveCredentials(existing);
      const expiresIn = Math.round((existing.expires - Date.now()) / 60000);
      const relogin = await vscode.window.showInformationMessage(
        `Kiro: Already authenticated (${existing.authMethod}, region: ${existing.region}, expires in ${expiresIn} min). Re-login?`,
        "Re-login", "Cancel"
      );
      if (relogin !== "Re-login") return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: "Builder ID", description: "AWS Builder ID (default)", value: "builder-id" },
        { label: "Your organization", description: "IAM Identity Center (SSO)", value: "idc" },
      ],
      { title: "Kiro Login", placeHolder: "Select login method" }
    );

    if (!choice) return;

    let startUrl = BUILDER_ID_START_URL;
    if (choice.value === "idc") {
      const url = await vscode.window.showInputBox({
        prompt: "Enter your IAM Identity Center start URL",
        placeHolder: "https://mycompany.awsapps.com/start",
        validateInput: (v) => v.startsWith("http") ? null : "Must be a valid URL",
      });
      if (!url) return;
      startUrl = url;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Kiro Login", cancellable: true },
      async (progress, token) => {
        progress.report({ message: "Waiting for browser authorization..." });
        this.credentials = await loginWithDeviceCode(startUrl, token);
        await this.saveCredentials(this.credentials);
        vscode.window.showInformationMessage("Kiro: Login successful!");
      }
    );
  }

  async logout(): Promise<void> {
    this.credentials = undefined;
    await this.context.secrets.delete(this.secretStorageKey);
    vscode.window.showInformationMessage("Kiro: Logged out.");
  }

  private async saveCredentials(creds: KiroCredentials): Promise<void> {
    await this.context.secrets.store(this.secretStorageKey, JSON.stringify(creds));
  }
}
