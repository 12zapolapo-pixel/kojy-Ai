/**
 * Analytics Package
 *
 * SKILLS: 70 (Journey Map), 71 (Funnel), 72 (Retention),
 *         73 (ROI Calculator), 74 (Heatmap), 75 (NLP Topics),
 *         76 (Anomaly Detector), 77 (Export Engine)
 *
 * OWNERSHIP: packages/analytics
 * LAYER: Data — read-heavy analytics and reporting
 *
 * ARCHITECTURE:
 * - Analytics data flows: interactions table → aggregation worker → analytics_snapshots
 * - All dashboard queries hit analytics_snapshots (pre-aggregated) — NOT interactions
 * - Raw interactions only queried for drill-down and exports
 * - Anomaly detection runs as a nightly worker job
 * - Export engine streams large datasets to S3 — never loads entire dataset in memory
 *
 * PERFORMANCE:
 * - All queries use indexed orgId + period + periodStart columns
 * - Dashboard widgets cache results for 5 minutes in Redis
 * - Large exports are async — user gets download link via email/notification
 * - Real-time heatmap uses a separate Redis sorted set updated per-interaction
 */

import { aiChat } from "@kojyai/shared/ai";

// ─── SKILL #71: Conversion Funnel ────────────────────────────────────────────

export interface FunnelStep {
  name:       string;
  count:      number;
  dropoffPct: number;
  avgTimeMs:  number;
}

export interface FunnelAnalysis {
  steps:           FunnelStep[];
  overallCvr:      number; // conversion rate: last / first step
  biggestDropoff:  string; // name of step with biggest drop
  period:          string;
}

/**
 * Analyzes conversion through a defined funnel of events.
 * Funnel steps are user-defined (e.g., "greeted" → "engaged" → "returned").
 * Uses interaction records to count users reaching each step.
 */
export function calculateFunnelDropoff(
  stepCounts: number[],
  stepNames: string[],
): FunnelAnalysis {
  const steps: FunnelStep[] = stepCounts.map((count, i) => {
    const prevCount = i === 0 ? count : (stepCounts[i - 1] ?? count);
    return {
      name:       stepNames[i] ?? `Step ${i + 1}`,
      count,
      dropoffPct: prevCount > 0 ? ((prevCount - count) / prevCount) * 100 : 0,
      avgTimeMs:  0, // Populated from query
    };
  });

  const first = steps[0]?.count ?? 0;
  const last = steps[steps.length - 1]?.count ?? 0;
  const overallCvr = first > 0 ? (last / first) * 100 : 0;

  const biggestDropoff = steps.reduce(
    (max, step) => step.dropoffPct > max.dropoffPct ? step : max,
    steps[0]!,
  );

  return {
    steps,
    overallCvr,
    biggestDropoff: biggestDropoff?.name ?? "",
    period:         new Date().toISOString().slice(0, 7),
  };
}

// ─── SKILL #72: Cohort Retention Analysis ────────────────────────────────────

export interface RetentionCohort {
  cohortDate:  string;   // Week/month when users first appeared
  totalUsers:  number;
  retentionByWeek: number[];  // % retained at each week (week 0 = 100%)
}

export interface RetentionMatrix {
  cohorts:        RetentionCohort[];
  avgWeek1:       number;
  avgWeek4:       number;
  bestCohort:     string;
  worstCohort:    string;
}

/** Builds a retention matrix from raw interaction data */
export function buildRetentionMatrix(
  cohortData: Array<{ cohortDate: string; userId: number; weekNumber: number }>,
): RetentionMatrix {
  const cohortMap = new Map<string, Set<number>[]>();

  for (const row of cohortData) {
    if (!cohortMap.has(row.cohortDate)) {
      cohortMap.set(row.cohortDate, []);
    }
    const weeks = cohortMap.get(row.cohortDate)!;
    while (weeks.length <= row.weekNumber) {
      weeks.push(new Set<number>());
    }
    weeks[row.weekNumber]!.add(row.userId);
  }

  const cohorts: RetentionCohort[] = [];

  for (const [cohortDate, weeks] of cohortMap) {
    const totalUsers = weeks[0]?.size ?? 0;
    const retentionByWeek = weeks.map((week) =>
      totalUsers > 0 ? (week.size / totalUsers) * 100 : 0,
    );
    cohorts.push({ cohortDate, totalUsers, retentionByWeek });
  }

  const avgWeek1 = avg(cohorts.map((c) => c.retentionByWeek[1] ?? 0));
  const avgWeek4 = avg(cohorts.map((c) => c.retentionByWeek[4] ?? 0));

  const bestCohort  = cohorts.reduce((a, b) => (b.retentionByWeek[1] ?? 0) > (a.retentionByWeek[1] ?? 0) ? b : a, cohorts[0]!);
  const worstCohort = cohorts.reduce((a, b) => (b.retentionByWeek[1] ?? 0) < (a.retentionByWeek[1] ?? 0) ? b : a, cohorts[0]!);

  return {
    cohorts,
    avgWeek1,
    avgWeek4,
    bestCohort:  bestCohort?.cohortDate ?? "",
    worstCohort: worstCohort?.cohortDate ?? "",
  };
}

// ─── SKILL #73: Bot ROI Calculator ───────────────────────────────────────────

export interface BotRoiInput {
  botId:            string;
  period:           { start: string; end: string };
  subscriptionCost: number;   // Monthly cost in cents
  uniqueUsers:      number;
  retainedUsers:    number;
  goldEarned:       number;   // Game currency (Highrise-specific)
  hoursOperating:   number;
  comparedToManual: {
    hourlyRate:     number;   // Manual operator hourly rate in cents
  };
}

export interface BotRoiResult {
  totalCost:          number;
  estimatedValue:     number;
  roiPct:             number;
  costPerUser:        number;
  costPerRetainedUser: number;
  manualEquivalentCost: number;
  savingsVsManual:    number;
  paybackPeriodDays:  number;
  verdict:            "excellent" | "good" | "neutral" | "poor";
}

export function calculateBotRoi(input: BotRoiInput): BotRoiResult {
  const totalCost = input.subscriptionCost; // Monthly
  const manualEquivalentCost = input.hoursOperating * input.comparedToManual.hourlyRate;
  const savingsVsManual = Math.max(0, manualEquivalentCost - totalCost);

  // Estimated value: each retained user worth $0.50 avg LTV proxy
  const estimatedValue = input.retainedUsers * 50 + savingsVsManual;
  const roiPct = totalCost > 0 ? ((estimatedValue - totalCost) / totalCost) * 100 : 0;
  const costPerUser = input.uniqueUsers > 0 ? totalCost / input.uniqueUsers : 0;
  const costPerRetainedUser = input.retainedUsers > 0 ? totalCost / input.retainedUsers : 0;

  const paybackPeriodDays =
    estimatedValue > 0 ? Math.ceil((totalCost / estimatedValue) * 30) : 999;

  const verdict: BotRoiResult["verdict"] =
    roiPct > 100  ? "excellent" :
    roiPct > 20   ? "good" :
    roiPct > -10  ? "neutral" : "poor";

  return {
    totalCost,
    estimatedValue,
    roiPct,
    costPerUser,
    costPerRetainedUser,
    manualEquivalentCost,
    savingsVsManual,
    paybackPeriodDays,
    verdict,
  };
}

// ─── SKILL #74: Real-Time Heatmap ─────────────────────────────────────────────

export interface HeatmapCell {
  x:     number; // hour of day (0-23)
  y:     number; // day of week (0-6, 0=Monday)
  value: number; // interaction count
}

export interface HeatmapData {
  cells:     HeatmapCell[];
  maxValue:  number;
  peakHour:  number;
  peakDay:   number;
  timezone:  string;
}

/**
 * Generates a 7×24 activity heatmap from interaction timestamps.
 * Used for the "when are users most active" visualization.
 * Real-time updates pushed via WebSocket when new interactions arrive.
 */
export function buildActivityHeatmap(
  timestamps: Date[],
  timezone = "UTC",
): HeatmapData {
  const cells: HeatmapCell[] = [];
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const ts of timestamps) {
    // Adjust to timezone (simplified — production uses proper tz library)
    const day = ts.getDay(); // 0=Sun, shift to Mon=0
    const mon0Day = (day + 6) % 7;
    const hour = ts.getHours();
    grid[mon0Day]![hour]! += 1;
  }

  let maxValue = 0;
  let peakHour = 0;
  let peakDay = 0;

  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 24; x++) {
      const value = grid[y]![x]!;
      cells.push({ x, y, value });
      if (value > maxValue) {
        maxValue = value;
        peakHour = x;
        peakDay  = y;
      }
    }
  }

  return { cells, maxValue, peakHour, peakDay, timezone };
}

// ─── SKILL #75: NLP Topic Modeling ───────────────────────────────────────────

export interface TopicCluster {
  topic:       string;
  keywords:    string[];
  messageCount: number;
  avgSentiment: number;
  trend:       "rising" | "stable" | "falling";
}

/**
 * Extracts conversation topics from message content using Claude.
 * Groups messages into semantic clusters for the intelligence dashboard.
 * Runs as a nightly worker job — NOT synchronously on message receipt.
 */
export async function extractTopics(
  messages: string[],
  limit = 10,
): Promise<TopicCluster[]> {
  if (messages.length < 10) return [];

  // Sample messages to stay within token limits
  const sample = messages
    .sort(() => Math.random() - 0.5)
    .slice(0, 100)
    .join("\n");

  try {
    const response = await aiChat([
      { role: "system", content: "Extract the top conversation topics. Respond ONLY with valid JSON array: [{\"topic\":\"string\",\"keywords\":[],\"messageCount\":0,\"avgSentiment\":0,\"trend\":\"stable\"}]" },
      { role: "user", content: `Analyze these messages and identify top ${limit} topics:\n${sample}` },
    ], { maxTokens: 800 });

    const raw = response.text;

    return JSON.parse(raw.replace(/```json|```/g, "").trim()) as TopicCluster[];
  } catch {
    return [];
  }
}

// ─── SKILL #76: Anomaly Detector ─────────────────────────────────────────────

export interface AnomalyAlert {
  metricType:   string;
  currentValue: number;
  expectedRange: [number, number];
  zScore:        number;
  severity:      "warning" | "critical";
  detectedAt:    string;
  description:   string;
}

/**
 * Detects statistical anomalies in metric time series.
 * Uses Z-score method with 7-day rolling window.
 * Fires WS alert + notification when anomaly detected.
 * Thresholds: |z| > 2.5 = warning, |z| > 3.5 = critical
 */
export function detectAnomalies(
  metricType: string,
  values:     number[],
  currentValue: number,
): AnomalyAlert | null {
  if (values.length < 7) return null;

  const mean   = avg(values);
  const stdDev = Math.sqrt(avg(values.map((v) => Math.pow(v - mean, 2))));

  if (stdDev === 0) return null;

  const zScore = Math.abs((currentValue - mean) / stdDev);

  if (zScore < 2.5) return null;

  const severity = zScore > 3.5 ? "critical" : "warning";
  const low  = mean - 2.5 * stdDev;
  const high = mean + 2.5 * stdDev;

  return {
    metricType,
    currentValue,
    expectedRange: [Math.max(0, low), high],
    zScore,
    severity,
    detectedAt:    new Date().toISOString(),
    description: `${metricType} is ${currentValue > mean ? "abnormally high" : "abnormally low"} (z=${zScore.toFixed(2)})`,
  };
}

// ─── SKILL #77: Export Engine ─────────────────────────────────────────────────

export type ExportFormat = "csv" | "json" | "xlsx";

export interface ExportRequest {
  orgId:      number;
  dataType:   "interactions" | "analytics" | "bots" | "audit_logs" | "relationships";
  format:     ExportFormat;
  dateRange:  { start: string; end: string };
  filters?:   Record<string, unknown>;
}

// FIX-AUDIT: This file declared ExportJob twice with conflicting `status`
// literal unions ("ready" vs "complete") — TypeScript's declaration merging
// rejected the conflict outright (TS2717), breaking the build for every
// consumer of this package. The interface below (with downloadUrl/expiresAt/
// rowCount) was the orphaned one: nothing in the repo references those fields,
// and createExportJob() below returns the *other* shape. Removed it rather
// than guessing how to reconcile them.
//
// IMPORTANT — separate, larger gap this surfaced: createExportJob() enqueues
// QUEUE_NAMES.ANALYTICS_EXPORT (per the usage comment below), but no worker
// processor in apps/worker/src/processors consumes that queue, and no API
// router endpoint exists to poll a job's status or return a download link.
// The export flow currently dead-ends after enqueue — a job is created and
// then nothing ever finishes it. This needs a real processor + status
// endpoint; flagging here rather than fixing inline since it's a feature
// gap, not a type error.

export interface ExportJob {
  id:        string;
  status:    "queued" | "processing" | "complete" | "failed";
  createdAt: string;
  format:    ExportFormat;
  filters?:  ExportRequest["filters"];
}

/**
 * Creates and enqueues a data export job.
 *
 * DESIGN: This package cannot import queue infrastructure directly (it is a
 * shared utility package, not an app). Instead it accepts an `enqueue` callback
 * so the caller (API router) supplies its own queue binding. This keeps the
 * package infrastructure-agnostic while ensuring the job is actually persisted.
 *
 * USAGE in API router:
 *   const job = await createExportJob(request, (jobId, data) =>
 *     enqueue(QUEUE_NAMES.ANALYTICS_EXPORT, { jobId, ...data })
 *   );
 *
 * BUG-STUB-2 FIX: Previously returned a fake object with Math.random() ID and
 * never called any queue. The UI treated it as a real queued job — users would
 * wait for a download link that would never arrive.
 */
export async function createExportJob(
  request: ExportRequest,
  enqueue: (jobId: string, data: ExportRequest) => Promise<void>,
): Promise<ExportJob> {
  // Generate a stable, collision-resistant job ID
  // Format: exp_{timestamp}_{6-char random} — readable in logs, sortable by time
  const timestamp = Date.now();
  const random    = Math.random().toString(36).slice(2, 8);
  const jobId     = `exp_${timestamp}_${random}`;

  // Enqueue BEFORE returning — if this throws, the caller gets an error
  // rather than a fake job ID for a job that doesn't exist in the queue.
  await enqueue(jobId, request);

  return {
    id:        jobId,
    status:    "queued",
    createdAt: new Date(timestamp).toISOString(),
    format:    request.format,
    filters:   request.filters,
  };
}

export function formatCsvRow(obj: Record<string, unknown>): string {
  return Object.values(obj)
    .map((v) => {
      const str = String(v ?? "");
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    })
    .join(",");
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
