// Retention for the native/ per-thread frame logs. A live log past the size cap rolls to a numbered fragment
// (<tid>.<n>.ndjson, n allocated once, never reused) so the writer goes on appending to a clean <tid>.ndjson; a
// log idle past the window — mtime is the last activity — compresses to <name>.gz. Busy threads are never
// touched, and one file's failure is reported, not fatal.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const NATIVE_LOG_ROTATE_BYTES = 20 * 1024 * 1024;
export const NATIVE_LOG_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const CURRENT = /^(?<threadId>[\w-]+)\.ndjson$/;
const FRAGMENT = /^(?<threadId>[\w-]+)\.(?<index>\d+)\.ndjson$/;

export interface NativeLogSweepResult {
  rotated: number;
  compressed: number;
  skippedBusy: number;
  failed: number;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function sweepNativeLogs(
  nativeDir: string,
  options: {
    isBusy?: (threadId: string) => boolean;
    now?: number;
    rotateBytes?: number;
    idleMs?: number;
  } = {},
): NativeLogSweepResult {
  const isBusy = options.isBusy ?? (() => false);
  const now = options.now ?? Date.now();
  const rotateBytes = options.rotateBytes ?? NATIVE_LOG_ROTATE_BYTES;
  const idleMs = options.idleMs ?? NATIVE_LOG_IDLE_MS;
  const result: NativeLogSweepResult = { rotated: 0, compressed: 0, skippedBusy: 0, failed: 0 };
  let names: string[];
  try {
    names = readdirSync(nativeDir);
  } catch {
    return result;
  }
  const allocated = new Map<string, number>();
  const allocateIndex = (threadId: string): number => {
    let next = allocated.get(threadId);
    if (next === undefined) {
      const pattern = new RegExp(`^${threadId}\\.(\\d+)\\.ndjson(?:\\.gz)?$`);
      next = names.reduce((max, name) => {
        const found = pattern.exec(name);
        return found ? Math.max(max, Number(found[1]) + 1) : max;
      }, 1);
    }
    allocated.set(threadId, next + 1);
    return next;
  };
  for (const name of names) {
    const match = CURRENT.exec(name) ?? FRAGMENT.exec(name);
    if (!match?.groups) continue;
    let staging: string | undefined;
    try {
      if (isBusy(match.groups.threadId)) {
        result.skippedBusy++;
        continue;
      }
      const threadId = match.groups.threadId;
      let file = join(nativeDir, name);
      const stat = statSync(file);
      if (CURRENT.test(name) && stat.size > rotateBytes) {
        const rolled = join(nativeDir, `${threadId}.${allocateIndex(threadId)}.ndjson`);
        renameSync(file, rolled);
        result.rotated++;
        file = rolled;
      }
      if (now - stat.mtimeMs <= idleMs) continue;
      let target = `${file}.gz`;
      if (existsSync(target)) target = join(nativeDir, `${threadId}.${allocateIndex(threadId)}.ndjson.gz`);
      staging = `${target}.part`;
      writeFileSync(staging, gzipSync(readFileSync(file)), { mode: 0o600 });
      renameSync(staging, target);
      staging = undefined;
      utimesSync(target, stat.atime, stat.mtime);
      unlinkSync(file);
      result.compressed++;
    } catch (error) {
      if (staging) {
        try {
          unlinkSync(staging);
        } catch {}
      }
      result.failed++;
      console.warn(`[retention] ${join(nativeDir, name)}: ${reason(error)}`);
    }
  }
  return result;
}
