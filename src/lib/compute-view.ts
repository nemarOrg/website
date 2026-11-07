/**
 * Pure view models for the `/compute` page (website ADR 0030 phase E2 addendum). Each function turns
 * what the API said into the text and numbers a panel prints, so the Astro templates, the browser script
 * and the tests all read one place. Nothing here decides what a state MEANS (the backend does); it
 * decides what the page shows for each state it was told.
 *
 * Rules every function keeps:
 *  - Backend strings (a partition, an app, an unknown state) pass through `displaySafeLine` and are
 *    rendered as text nodes by the callers; no function returns markup.
 *  - Only `pools.cpu` and `pools.gpu` exist here, by name. A shared or institutional allocation, a
 *    platform remainder or a "covered by" line is never rendered, summed with or invented.
 *  - A throw is a panel's problem: the page runs each builder in its own `try/catch` and shows that
 *    panel's notice (Astro silently drops a component whose render throws).
 *  - Amounts are whole milli-SU and sums go through `sumMilli`.
 */
import { ACCOUNT_COPY, fillCopy } from "./account-copy";
import { BADGE_TONE_ICONS, type BadgeTone } from "./admin-badges";
import { isComputeAccessState } from "./compute-access-state";
import {
  ComputeApiError,
  type ComputeJob,
  type ComputeMe,
  type ComputePool,
  type ComputeQueueEstimate,
  type ComputeUsage,
} from "./compute-api";
import { type JobBadge, jobBadge, sourceLabel } from "./compute-badges";
import { type UsageChart, type UsageRow, computeUsageChart } from "./compute-chart";
import {
  COMPUTE_JOB_ID_RE,
  COMPUTE_QUEUE_MIN_SAMPLES,
  isComputeJobState,
  isTerminalComputeState,
} from "./compute-contract";
import {
  dbTimeToIso,
  formatDuration,
  suFixed,
  formatUtcDate,
  formatUtcMinute,
  formatUtcSecond,
  sumMilli,
} from "./compute-format";
import { COMPUTE_LABELS, daysText } from "./compute-labels";
import { displaySafeLine } from "./mail-display";
import type { IconName } from "./status-icons";

export const SETTINGS_COMPUTE_HREF = "/settings#compute-access";

// --- Which panels --------------------------------------------------------------------------------

export interface PanelPlan {
  readonly access: true;
  readonly balances: boolean;
  readonly usage: boolean;
  readonly jobs: boolean;
  readonly queue: boolean;
  /** Whether usage and jobs should be READ at all (nothing exists to read for the other states). */
  readonly readLedger: boolean;
}

/**
 * Which panels a state shows. A state outside the closed six shows the Access panel and nothing else:
 * the page decides nothing the backend did not state. `suspended` and `revoked` keep their history and
 * balance read-only and lose the queue (it only helps someone who can submit).
 */
export function panelsFor(state: string | null, opts: { unverified?: boolean } = {}): PanelPlan {
  const none: PanelPlan = {
    access: true,
    balances: false,
    usage: false,
    jobs: false,
    queue: false,
    readLedger: false,
  };
  if (opts.unverified || state === null) return none;
  if (state === "active") {
    return { access: true, balances: true, usage: true, jobs: true, queue: true, readLedger: true };
  }
  if (state === "suspended" || state === "revoked") {
    return {
      access: true,
      balances: true,
      usage: true,
      jobs: true,
      queue: false,
      readLedger: true,
    };
  }
  return none;
}

// --- Failed reads --------------------------------------------------------------------------------

export interface NoticeView {
  readonly title: string;
  readonly reason: string;
  /** The backend's own sentence, safe to print as text; absent when it sent none. */
  readonly sentence: string | null;
  readonly missing: string;
  readonly retryLabel: string;
}

/** What a panel shows when its read (or its builder) failed. The figures are missing, which is not zero. */
export function noticeFor(panel: string, err: unknown): NoticeView {
  const n = COMPUTE_LABELS.notice;
  let reason: string = n.shape;
  let sentence: string | null = null;
  if (err instanceof ComputeApiError) {
    reason = n[err.kind === "rejected" ? "rejected" : err.kind];
    // A shape error's sentence is ours, and the reason already says it.
    if (err.kind !== "shape" && err.sentence) sentence = displaySafeLine(err.sentence);
  }
  return {
    title: `${n.title} ${panel.toLowerCase()}`,
    reason,
    sentence,
    missing: n.missing,
    retryLabel: n.retry,
  };
}

// --- Access --------------------------------------------------------------------------------------

export interface AccessView {
  readonly state: string;
  readonly known: boolean;
  readonly badge: { readonly label: string; readonly tone: BadgeTone; readonly icon: IconName };
  /** Sentences from the shared copy, in order. */
  readonly paragraphs: readonly string[];
  readonly link: { readonly href: string; readonly label: string } | null;
  /** True only for an ACTIVE account whose pool is frozen (the CLI's rule). */
  readonly frozen: boolean;
  readonly grantedSince: string | null;
}

const ACCESS_TONES: Readonly<Record<string, BadgeTone>> = {
  none: "neutral",
  requested: "info",
  active: "success",
  suspended: "warning",
  denied: "neutral",
  revoked: "neutral",
};

/**
 * The Access panel for a state. `me` is null when `GET /compute/me` itself failed and the state came from
 * the session: the panel then says only the state, because the request-open flag and the dates are the
 * read's to give.
 */
export function accessView(
  state: string,
  me: ComputeMe | null,
  opts: { frozen?: boolean } = {},
): AccessView {
  const known = isComputeAccessState(state);
  const label = known
    ? ACCOUNT_COPY[`compute_access.state.${state}` as const]
    : displaySafeLine(state.trim() || "Unknown");
  const tone: BadgeTone = known ? ACCESS_TONES[state] : "neutral";
  const paragraphs: string[] = [];
  let link: AccessView["link"] = null;
  const access = me?.access ?? null;
  switch (state) {
    case "none":
      if (access) {
        const open = access.requests_open ?? access.terms_published;
        if (open) {
          link = { href: SETTINGS_COMPUTE_HREF, label: ACCOUNT_COPY["compute_access.request.cta"] };
        } else {
          paragraphs.push(ACCOUNT_COPY["compute_access.terms_unpublished.body"]);
        }
      }
      break;
    case "requested": {
      const date = access?.requested_at ? formatUtcDate(access.requested_at) : "";
      paragraphs.push(
        date
          ? fillCopy(ACCOUNT_COPY["compute_access.requested.lede_dated"], { date })
          : ACCOUNT_COPY["compute_access.requested.lede"],
        ACCOUNT_COPY["compute_access.requested.body"],
      );
      break;
    }
    case "suspended":
      paragraphs.push(ACCOUNT_COPY["compute_access.suspended.body"]);
      break;
    case "denied":
    case "revoked":
      paragraphs.push(ACCOUNT_COPY["compute_access.closed.body"]);
      break;
    default:
      break;
  }
  const frozen = state === "active" && opts.frozen === true;
  if (frozen) paragraphs.push(ACCOUNT_COPY["compute_page.frozen.body"]);
  return {
    state,
    known,
    badge: { label, tone, icon: BADGE_TONE_ICONS[tone] },
    paragraphs,
    link,
    frozen,
    grantedSince:
      state === "active" && access?.granted_at ? formatUtcDate(access.granted_at) : null,
  };
}

// --- Balances ------------------------------------------------------------------------------------

export interface BalanceRow {
  readonly key: "granted" | "held" | "charged" | "available";
  readonly label: string;
  readonly text: string;
  readonly negative: boolean;
}

export interface PoolBalanceView {
  readonly pool: "cpu" | "gpu";
  readonly name: string;
  readonly rows: readonly BalanceRow[];
  /** Percent of the grant still available, 0 to 100, for the decorative bar; null when nothing was granted. */
  readonly barPercent: number | null;
  readonly nothingGranted: boolean;
  readonly negativeAvailable: boolean;
}

function poolView(pool: "cpu" | "gpu", p: ComputePool): PoolBalanceView {
  const L = COMPUTE_LABELS.balance;
  const negative = p.available_milli < 0;
  const rows: BalanceRow[] = [
    { key: "granted", label: L.granted, text: suFixed(p.granted_milli), negative: false },
    { key: "held", label: L.held, text: suFixed(p.held_milli), negative: false },
    { key: "charged", label: L.charged, text: suFixed(p.charged_milli), negative: false },
    { key: "available", label: L.available, text: suFixed(p.available_milli), negative },
  ];
  // The bar is decoration: the numbers carry the meaning, and nothing printed comes from this division.
  const barPercent =
    p.granted_milli > 0
      ? Math.round(Math.min(100, Math.max(0, (p.available_milli / p.granted_milli) * 100)) * 1000) /
        1000
      : null;
  return {
    pool,
    name: COMPUTE_LABELS.pools[pool],
    rows,
    barPercent,
    nothingGranted: p.granted_milli === 0,
    negativeAvailable: negative,
  };
}

export interface BalancesView {
  /** CPU then GPU, from `pools.cpu` and `pools.gpu` only. The two are never added together. */
  readonly pools: readonly PoolBalanceView[];
  readonly notes: readonly string[];
  readonly anyNegative: boolean;
}

export function balancesView(me: ComputeMe): BalancesView {
  const pools = [poolView("cpu", me.pools.cpu), poolView("gpu", me.pools.gpu)];
  const anyNegative = pools.some((p) => p.negativeAvailable);
  const notes: string[] = [
    ACCOUNT_COPY["compute_page.units_note"],
    ACCOUNT_COPY["compute_page.available_note"],
  ];
  return { pools, notes, anyNegative };
}

// --- Queue ---------------------------------------------------------------------------------------

export interface QueueRowView {
  readonly partition: string;
  readonly median: string;
  readonly p90: string;
  readonly counted: string;
  /** True when the sample was too thin: both figures read "Not enough data". */
  readonly thin: boolean;
}

export interface QueueView {
  readonly rows: readonly QueueRowView[];
  readonly empty: boolean;
  readonly emptyText: string;
  readonly intro: string;
  readonly note: string;
}

function queueRow(q: ComputeQueueEstimate): QueueRowView {
  const L = COMPUTE_LABELS.queue;
  const thin = q.median_seconds === null || q.p90_seconds === null;
  const window = daysText(q.window_days);
  const belowMinimum = q.count < COMPUTE_QUEUE_MIN_SAMPLES;
  const counted = `${belowMinimum ? `${q.count} of ${COMPUTE_QUEUE_MIN_SAMPLES}` : q.count} in ${window}`;
  return {
    partition: displaySafeLine(q.partition),
    // A null is never a dash and never zero: both cells say there is not enough data, with the count beside.
    median: thin ? L.notEnough : formatDuration(q.median_seconds as number),
    p90: thin ? L.notEnough : formatDuration(q.p90_seconds as number),
    counted,
    thin,
  };
}

export function queueView(me: ComputeMe): QueueView {
  return {
    rows: me.queue.map(queueRow),
    empty: me.queue.length === 0,
    emptyText: COMPUTE_LABELS.queue.none,
    intro: COMPUTE_LABELS.queue.intro,
    note: ACCOUNT_COPY["compute_page.queue_note"],
  };
}

// --- Jobs ----------------------------------------------------------------------------------------

export interface JobRowView {
  readonly id: string;
  /** Null when the id is not `job_` and 24 hex digits: such a row renders without a link. */
  readonly href: string | null;
  readonly state: JobBadge;
  readonly stateWord: string;
  readonly cancelRequested: boolean;
  readonly app: string;
  readonly appVersion: string;
  readonly partition: string;
  readonly frontDoor: string;
  readonly createdText: string;
  readonly createdIso: string | null;
  readonly createdTitle: string;
  readonly charged: string;
  /** `terminal` and `live` are known states; `unknown` is one this build has no entry for. */
  readonly chargeKind: "terminal" | "live" | "unknown";
}

/**
 * One job as cells of data. The SSR template and the browser script are two thin renderers over this.
 * A finished job with no charge prints a true `0.000`; a live job with none reads "Not charged yet",
 * because the backend charges at the end; a state this build does not know prints its amount when it
 * has one and "Not known" when it has none (a claim of zero or of "not yet" would be a guess).
 */
export function jobRowView(job: ComputeJob): JobRowView {
  const L = COMPUTE_LABELS.jobs;
  const known = isComputeJobState(job.state);
  const terminal = known && isTerminalComputeState(job.state);
  let charged: string;
  let chargeKind: JobRowView["chargeKind"];
  if (terminal) {
    charged = suFixed(job.charged_milli);
    chargeKind = "terminal";
  } else if (known) {
    charged = job.charged_milli > 0 ? suFixed(job.charged_milli) : L.notChargedYet;
    chargeKind = "live";
  } else {
    charged = job.charged_milli > 0 ? suFixed(job.charged_milli) : L.chargeUnknown;
    chargeKind = "unknown";
  }
  const badge = jobBadge(job.state);
  return {
    id: displaySafeLine(job.id),
    href: COMPUTE_JOB_ID_RE.test(job.id) ? `/compute/jobs/${job.id}` : null,
    state: badge,
    stateWord: badge.label,
    cancelRequested: job.cancel_requested && known && !terminal,
    app: displaySafeLine(job.app_id),
    appVersion: displaySafeLine(job.app_version),
    partition: displaySafeLine(job.partition),
    frontDoor: sourceLabel(job.source),
    createdText: formatUtcMinute(job.created_at),
    createdIso: dbTimeToIso(job.created_at),
    createdTitle: formatUtcSecond(job.created_at),
    charged,
    chargeKind,
  };
}

export interface JobsView {
  readonly rows: readonly JobRowView[];
  readonly empty: boolean;
  readonly nextAfter: string | null;
  /** The `?after=` link that works without JavaScript; null on the last page. */
  readonly loadMoreHref: string | null;
  readonly showUnreportedNote: boolean;
  readonly unreportedNote: string;
}

export function jobsView(page: {
  jobs: readonly ComputeJob[];
  next_after: string | null;
}): JobsView {
  return {
    rows: page.jobs.map(jobRowView),
    empty: page.jobs.length === 0,
    nextAfter: page.next_after,
    loadMoreHref: page.next_after
      ? `/compute?after=${encodeURIComponent(page.next_after)}#jobs`
      : null,
    showUnreportedNote: page.jobs.some((j) => j.state === "unreported"),
    unreportedNote: ACCOUNT_COPY["compute_page.unreported_note"],
  };
}

// --- Usage ---------------------------------------------------------------------------------------

export interface LegendEntry {
  readonly name: string;
  readonly colorIndex: number;
  readonly totalText: string;
}

export interface PoolUsageView {
  readonly pool: "cpu" | "gpu";
  readonly name: string;
  readonly chart: UsageChart;
  readonly caption: string;
  readonly summary: string;
  readonly legend: readonly LegendEntry[];
  readonly barTitles: readonly string[];
  readonly ceilingText: string;
  readonly table: {
    readonly headers: readonly string[];
    readonly rows: readonly { label: string; cells: readonly string[]; total: string }[];
  };
  readonly negativeNote: string | null;
}

export interface UsageView {
  readonly windowText: string;
  readonly pools: readonly PoolUsageView[];
  readonly note: string;
  /** Rows that cannot be drawn: a correction naming no job, or a partition not offered. */
  readonly aside: {
    readonly label: string;
    readonly totalText: string;
    readonly rows: readonly { day: string; partition: string; amount: string }[];
  } | null;
  readonly anyRows: boolean;
}

const POOLS = ["cpu", "gpu"] as const;

export function usageView(me: ComputeMe, usage: ComputeUsage): UsageView {
  const L = COMPUTE_LABELS.usage;
  const rowsOfPool = new Map<string, UsageRow[]>(POOLS.map((p) => [p, []]));
  const partitionsOfPool = new Map<string, string[]>(POOLS.map((p) => [p, []]));
  const poolOfPartition = new Map<string, string>();
  for (const part of me.partitions) {
    if (rowsOfPool.has(part.pool) && !poolOfPartition.has(part.name)) {
      poolOfPartition.set(part.name, part.pool);
      partitionsOfPool.get(part.pool)?.push(part.name);
    }
  }
  const asideRows: ComputeUsage["rows"][number][] = [];
  for (const row of usage.rows) {
    const pool = row.partition === null ? undefined : poolOfPartition.get(row.partition);
    if (pool === undefined) asideRows.push(row);
    else rowsOfPool.get(pool)?.push(row);
  }

  const pools: PoolUsageView[] = [];
  for (const pool of POOLS) {
    const rows = rowsOfPool.get(pool) ?? [];
    const partitions = partitionsOfPool.get(pool) ?? [];
    const everUsed = me.pools[pool].granted_milli > 0 || me.pools[pool].charged_milli !== 0;
    // A pool with no row and nothing ever granted is not drawn at all.
    if (partitions.length === 0 || (rows.length === 0 && !everUsed)) continue;
    const chart = computeUsageChart({
      from: usage.from,
      to: usage.to,
      rows,
      partitions,
      otherLabel: L.other,
    });
    const names = chart.series.map((s) => displaySafeLine(s.name));
    const barTitles = chart.days.map((bar) => {
      const parts = bar.segments.map(
        (seg) => `${names[seg.seriesIndex]} ${suFixed(seg.milli)} SU`,
      );
      return parts.length === 0
        ? `${bar.label}: 0.000 SU`
        : `${bar.label}: ${parts.join(", ")}, total ${suFixed(bar.drawnMilli)} SU`;
    });
    const poolName = COMPUTE_LABELS.pools[pool];
    const days = chart.days.length;
    const busiest = chart.busiest;
    const busiestLabel = busiest
      ? (chart.days.find((d) => d.day === busiest.day)?.label ?? busiest.day)
      : null;
    const summary =
      busiest === null
        ? `${poolName} usage, ${days} days, no charges.`
        : `${poolName} usage, ${days} days, ${suFixed(chart.totalMilli)} SU charged on ${chart.daysWithCharges} days, busiest ${busiestLabel} (${suFixed(busiest.milli)} SU).`;
    pools.push({
      pool,
      name: poolName,
      chart,
      caption: `${poolName}: ${L.title}, ${usage.from} to ${usage.to} ${L.window}`,
      summary,
      legend: chart.series.map((s, i) => ({
        name: names[i],
        colorIndex: s.colorIndex,
        totalText: `${suFixed(s.netMilli)} SU`,
      })),
      barTitles,
      ceilingText: `${suFixed(chart.ceilingMilli)} SU`,
      table: {
        headers: [L.day, ...names, L.total],
        rows: chart.table.map((r) => ({
          label: r.label,
          cells: r.cells.map((c) => suFixed(c ?? 0)),
          total: suFixed(r.netMilli),
        })),
      },
      negativeNote: chart.omitted.cells.length > 0 ? L.negativeNote : null,
    });
  }

  const aside =
    asideRows.length === 0
      ? null
      : {
          label: L.adjustmentsLine,
          totalText: `${suFixed(sumMilli(asideRows.map((r) => r.charged_milli)))} SU`,
          rows: asideRows.map((r) => ({
            day: r.day,
            partition: r.partition === null ? L.noJob : displaySafeLine(r.partition),
            amount: suFixed(r.charged_milli),
          })),
        };

  return {
    windowText: `${usage.from} to ${usage.to}`,
    pools,
    note: ACCOUNT_COPY["compute_page.usage_note"],
    aside,
    anyRows: usage.rows.length > 0,
  };
}
