// The attachments' and the thread logs' upkeep. Both are safe beside requests: an upload in flight keeps its partial
// and its reservation, and a busy, unread or handed-off thread keeps its log. So the first pass runs once the server
// answers, not before it listens, and the logs' sweep then runs once a day. The native frame logs' retention (roll
// oversized live logs, compress idle ones) runs at startup too and then daily at 03:40 local — clear of the 03:30
// memory backup.
import { cleanupStaleAttachmentPartials } from "../attachments.ts";
import { NATIVE_DIR } from "../config.ts";
import { sweepNativeLogs, type NativeLogSweepResult } from "../native-retention.ts";
import type { BotRecord } from "../store.ts";
import { sweepThreadEventLogs } from "../thread-retention.ts";

export const THREAD_LOG_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
export const NATIVE_LOG_SWEEP_HOUR = 3;
export const NATIVE_LOG_SWEEP_MINUTE = 40;

export interface StartUpkeepDeps {
  bots: () => ReadonlyArray<Pick<BotRecord, "id" | "tasks">>;
  retentionDays: () => number | null;
  busy: (botId: string, threadId: string) => boolean;
  openDirectHandoff: (threadId: string) => boolean;
  cleanupPartials?: () => number;
  sweepLogs?: typeof sweepThreadEventLogs;
  threadBusy?: (threadId: string) => boolean;
  sweepNative?: (isBusy: (threadId: string) => boolean) => NativeLogSweepResult;
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The next local 03:40 strictly after `from`. */
export function nextNativeLogSweepAt(from: number): number {
  const at = new Date(from);
  at.setHours(NATIVE_LOG_SWEEP_HOUR, NATIVE_LOG_SWEEP_MINUTE, 0, 0);
  if (at.getTime() <= from) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export function startUpkeep(deps: StartUpkeepDeps): void {
  const sweepLogsNow = () => {
    const retentionDays = deps.retentionDays();
    if (retentionDays === null) return;
    const candidates = deps.bots().flatMap((bot) => (bot.tasks ?? []).map((task) => ({
      threadId: task.threadId,
      closedAt: task.closedBy?.at ?? null,
      archivedAt: task.archivedAt ?? null,
      unread: task.unread === true,
      busy: deps.busy(bot.id, task.threadId),
      openDirectHandoff: deps.openDirectHandoff(task.threadId),
    })));
    const swept = (deps.sweepLogs ?? sweepThreadEventLogs)(candidates, retentionDays);
    if (swept > 0) console.log(`[retention] removed event logs for ${swept} idle thread(s) past ${retentionDays} day(s)`);
  };
  const sweepNativeNow = () => {
    const sweep = deps.sweepNative ?? ((isBusy: (threadId: string) => boolean) => sweepNativeLogs(NATIVE_DIR, { isBusy }));
    const result = sweep(deps.threadBusy ?? (() => false));
    if (result.rotated > 0 || result.compressed > 0)
      console.log(`[retention] native frame logs: ${result.rotated} rotated, ${result.compressed} compressed`);
    if (result.failed > 0) console.warn(`[retention] native frame log sweep: ${result.failed} file(s) failed`);
  };
  setImmediate(() => {
    try {
      const reclaimed = (deps.cleanupPartials ?? cleanupStaleAttachmentPartials)();
      if (reclaimed > 0) console.log(`reclaimed ${reclaimed} abandoned upload partial(s)`);
    } catch (error) {
      console.warn(`attachments: startup partial cleanup failed: ${reason(error)}`);
    }
    try {
      sweepLogsNow();
    } catch (error) {
      console.warn(`thread event log retention sweep failed: ${reason(error)}`);
    }
    try {
      sweepNativeNow();
    } catch (error) {
      console.warn(`native frame log retention sweep failed: ${reason(error)}`);
    }
  });
  setInterval(sweepLogsNow, THREAD_LOG_RETENTION_SWEEP_MS).unref();
  const armNativeLogSweep = (): void => {
    setTimeout(() => {
      try {
        sweepNativeNow();
      } catch (error) {
        console.warn(`native frame log retention sweep failed: ${reason(error)}`);
      }
      armNativeLogSweep();
    }, Math.max(0, nextNativeLogSweepAt(Date.now()) - Date.now())).unref();
  };
  armNativeLogSweep();
}
