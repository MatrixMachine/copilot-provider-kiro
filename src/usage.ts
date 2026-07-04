// Kiro account usage query
// Fetches usage limits via AmazonCodeWhispererService.GetUsageLimits

import * as vscode from "vscode";
import type { KiroCredentials } from "./auth";
import { resolveApiRegion } from "./models";

const MANAGE_USAGE_URL = "https://app.kiro.dev/account/usage";
const JSON_HEADERS = {
  "Content-Type": "application/x-amz-json-1.0",
  "User-Agent": "copilot-provider-kiro",
} as const;

// --- Types ---

type EpochLike = number | string;

interface KiroFreeTrialInfo {
  freeTrialStatus?: string;
  freeTrialExpiry?: EpochLike;
  currentUsage?: number;
  currentUsageWithPrecision?: number;
  usageLimit?: number;
  usageLimitWithPrecision?: number;
}

interface KiroUsageBreakdown {
  resourceType?: string;
  displayName?: string;
  displayNamePlural?: string;
  currentUsage: number;
  currentUsageWithPrecision?: number;
  currentOverages: number;
  currentOveragesWithPrecision?: number;
  usageLimit: number;
  usageLimitWithPrecision?: number;
  unit?: string;
  overageCharges: number;
  currency?: string;
  overageRate?: number;
  nextDateReset?: EpochLike;
  overageCap?: number;
  overageCapWithPrecision?: number;
  freeTrialInfo?: KiroFreeTrialInfo;
}

interface KiroSubscriptionInfo {
  type?: string;
  upgradeCapability?: string;
  overageCapability?: string;
  subscriptionManagementTarget?: string;
  subscriptionTitle?: string;
}

interface KiroOverageConfiguration {
  overageStatus?: string;
}

interface KiroUsageLimitList {
  type?: string;
  currentUsage?: number;
  totalUsageLimit?: number;
  percentUsed?: number;
}

interface KiroUserInfo {
  userId?: string;
  email?: string;
}

interface KiroGetUsageLimitsResponse {
  limits?: KiroUsageLimitList[];
  nextDateReset?: EpochLike;
  daysUntilReset?: number;
  usageBreakdown?: KiroUsageBreakdown;
  usageBreakdownList?: KiroUsageBreakdown[];
  subscriptionInfo?: KiroSubscriptionInfo;
  overageConfiguration?: KiroOverageConfiguration;
  userInfo?: KiroUserInfo;
}

interface KiroListProfilesResponse {
  profiles?: Array<{ arn?: string }>;
}

// --- Helpers ---

function toIsoDate(value: EpochLike | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatCount(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMoney(amount: number | undefined, currency: string | undefined): string | undefined {
  if (amount === undefined || Number.isNaN(amount) || amount <= 0) return undefined;
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

// --- API calls ---

async function postOperation<TResponse>(
  accessToken: string,
  endpoint: string,
  target: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      "X-Amz-Target": target,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${target} failed: ${response.status} ${response.statusText}${text ? ` ${text}` : ""}`);
  }

  return (await response.json()) as TResponse;
}

async function listProfileArn(accessToken: string, endpoint: string): Promise<string | undefined> {
  try {
    const response = await postOperation<KiroListProfilesResponse>(
      accessToken,
      endpoint,
      "AmazonCodeWhispererService.ListAvailableProfiles",
      {},
    );
    return response.profiles?.find((p) => p.arn)?.arn;
  } catch {
    return undefined;
  }
}

function buildUsageBodies(profileArn: string | undefined): Array<Record<string, unknown>> {
  const maybeProfile = profileArn ? { profileArn } : {};
  return [
    { ...maybeProfile, origin: "CLI", resourceType: "CREDIT", isEmailRequired: false },
    { ...maybeProfile, origin: "CLI", resourceType: "CREDIT" },
    { ...maybeProfile, origin: "CLI" },
    { ...maybeProfile, origin: "CHATBOT", resourceType: "CREDIT", isEmailRequired: false },
    { ...maybeProfile, origin: "CHATBOT", resourceType: "CREDIT" },
    maybeProfile,
  ];
}

async function tryUsageBodies(
  accessToken: string,
  endpoint: string,
  bodies: Array<Record<string, unknown>>,
): Promise<KiroGetUsageLimitsResponse | undefined> {
  const seen = new Set<string>();
  for (const body of bodies) {
    const key = JSON.stringify(body);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return await postOperation<KiroGetUsageLimitsResponse>(
        accessToken,
        endpoint,
        "AmazonCodeWhispererService.GetUsageLimits",
        body,
      );
    } catch {
      // try next body variant
    }
  }
  return undefined;
}

async function fetchRawUsage(accessToken: string, endpoint: string): Promise<KiroGetUsageLimitsResponse> {
  // Try without profileArn first
  const direct = await tryUsageBodies(accessToken, endpoint, buildUsageBodies(undefined));
  if (direct) return direct;

  // Try with profileArn
  const profileArn = await listProfileArn(accessToken, endpoint);
  if (profileArn) {
    const profiled = await tryUsageBodies(accessToken, endpoint, buildUsageBodies(profileArn));
    if (profiled) return profiled;
  }

  throw new Error("GetUsageLimits failed: all request variants returned errors");
}

// --- Display ---

function formatUsageBucket(bucket: KiroUsageBreakdown): string {
  const used = bucket.currentUsageWithPrecision ?? bucket.currentUsage;
  const limit = bucket.usageLimitWithPrecision ?? bucket.usageLimit;
  const overages = bucket.currentOveragesWithPrecision ?? bucket.currentOverages;
  const label = bucket.displayName || bucket.resourceType || "Usage";
  const unit = bucket.unit ? ` ${bucket.unit}` : "";

  let line = `• ${label}: ${formatCount(used)}${unit}`;
  if (limit > 0) {
    const pct = Math.round((used / limit) * 100);
    line += ` / ${formatCount(limit)}${unit} (${pct}%)`;
  }

  if (overages && overages > 0) {
    line += ` | Overages: ${formatCount(overages)}`;
    const chargesDisplay = formatMoney(bucket.overageCharges, bucket.currency);
    if (chargesDisplay) line += ` ($${chargesDisplay})`;
  }

  if (bucket.freeTrialInfo) {
    const ftUsed = bucket.freeTrialInfo.currentUsageWithPrecision ?? bucket.freeTrialInfo.currentUsage;
    const ftLimit = bucket.freeTrialInfo.usageLimitWithPrecision ?? bucket.freeTrialInfo.usageLimit;
    if (ftUsed !== undefined && ftLimit !== undefined) {
      line += `\n  Bonus: ${formatCount(ftUsed)} / ${formatCount(ftLimit)}`;
    }
    if (bucket.freeTrialInfo.freeTrialExpiry) {
      line += ` (expires ${toIsoDate(bucket.freeTrialInfo.freeTrialExpiry)?.split("T")[0] ?? "?"})`;
    }
  }

  return line;
}

function buildUsageMessage(raw: KiroGetUsageLimitsResponse): string {
  const lines: string[] = [];

  // Subscription info
  if (raw.subscriptionInfo?.subscriptionTitle) {
    lines.push(`📋 Plan: ${raw.subscriptionInfo.subscriptionTitle}`);
  }

  // Reset info
  if (raw.daysUntilReset !== undefined) {
    const resetDate = toIsoDate(raw.nextDateReset)?.split("T")[0];
    lines.push(`🔄 Reset: ${resetDate ?? "?"} (${raw.daysUntilReset} days)`);
  }

  // Overage status
  if (raw.overageConfiguration?.overageStatus) {
    lines.push(`⚡ Overage: ${raw.overageConfiguration.overageStatus}`);
  }

  lines.push("");

  // Usage buckets
  const buckets = raw.usageBreakdownList?.length
    ? raw.usageBreakdownList
    : raw.usageBreakdown
      ? [raw.usageBreakdown]
      : [];

  if (buckets.length > 0) {
    lines.push("📊 Usage:");
    for (const bucket of buckets) {
      lines.push(formatUsageBucket(bucket));
    }
  } else if (raw.limits?.length) {
    lines.push("📊 Usage:");
    for (const limit of raw.limits) {
      const pct = limit.percentUsed !== undefined ? ` (${Math.round(limit.percentUsed)}%)` : "";
      lines.push(`• ${limit.type || "Usage"}: ${limit.currentUsage ?? 0} / ${limit.totalUsageLimit ?? "∞"}${pct}`);
    }
  } else {
    lines.push("No usage data available.");
  }

  // User info
  if (raw.userInfo?.email) {
    lines.push("");
    lines.push(`👤 ${raw.userInfo.email}`);
  }

  return lines.join("\n");
}

// --- Public API ---

export async function showKiroUsage(
  credentials: KiroCredentials,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const region = resolveApiRegion(credentials.region);
  const endpoint = `https://q.${region}.amazonaws.com/`;

  try {
    const raw = await fetchRawUsage(credentials.access, endpoint);
    const message = buildUsageMessage(raw);

    outputChannel.appendLine(`[Kiro] Usage:\n${message}`);

    const action = await vscode.window.showInformationMessage(
      message,
      { modal: false },
      "Manage Usage",
      "Copy",
    );

    if (action === "Manage Usage") {
      vscode.env.openExternal(vscode.Uri.parse(MANAGE_USAGE_URL));
    } else if (action === "Copy") {
      await vscode.env.clipboard.writeText(message);
      vscode.window.showInformationMessage("Usage info copied to clipboard.");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Kiro] Usage query failed: ${msg}`);
    vscode.window.showErrorMessage(`Kiro usage query failed: ${msg}`);
  }
}
