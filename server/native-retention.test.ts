import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { NATIVE_LOG_IDLE_MS, sweepNativeLogs } from "./native-retention.ts";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "omb-native-retention-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-24T12:00:00Z");
const OLD = NOW - NATIVE_LOG_IDLE_MS - 60_000;
const RECENT = NOW - 60_000;
const CAP = 64;
const line = (o: unknown) => JSON.stringify(o) + "\n";
const frame = (i: number) => line({ at: `2026-11-20T00:00:${String(i).padStart(2, "0")}.000Z`, dir: "in", source: "test", msg: { i } });

function write(dir: string, name: string, body: string | Buffer, mtime = RECENT) {
  const file = join(dir, name);
  writeFileSync(file, body, { mode: 0o600 });
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

const gunzipped = (dir: string, name: string) => gunzipSync(readFileSync(join(dir, name))).toString("utf8");

describe("sweepNativeLogs", () => {
  it("never touches a busy thread's log, however big or old", () => {
    const dir = tmp();
    const body = frame(1).repeat(10);
    const file = write(dir, "t1.ndjson", body, OLD);
    const result = sweepNativeLogs(dir, { isBusy: () => true, now: NOW, rotateBytes: CAP });
    expect(result).toEqual({ rotated: 0, compressed: 0, skippedBusy: 1, failed: 0 });
    expect(readFileSync(file, "utf8")).toBe(body);
    expect(readdirSync(dir)).toEqual(["t1.ndjson"]);
  });

  it("rolls an oversized live log to the next free fragment index, never reusing one", () => {
    const dir = tmp();
    write(dir, "t1.1.ndjson", frame(0));
    write(dir, "t1.2.ndjson.gz", gzipSync(frame(0)));
    const body = frame(1).repeat(10);
    write(dir, "t1.ndjson", body);
    const result = sweepNativeLogs(dir, { now: NOW, rotateBytes: CAP });
    expect(result).toMatchObject({ rotated: 1, compressed: 0, failed: 0 });
    expect(readdirSync(dir).sort()).toEqual(["t1.1.ndjson", "t1.2.ndjson.gz", "t1.3.ndjson"]);
    expect(readFileSync(join(dir, "t1.3.ndjson"), "utf8")).toBe(body);
  });

  it("compresses a log idle past the window and deletes the original, then is a no-op", () => {
    const dir = tmp();
    const body = frame(1) + frame(2);
    write(dir, "t1.ndjson", body, OLD);
    const result = sweepNativeLogs(dir, { now: NOW });
    expect(result).toMatchObject({ rotated: 0, compressed: 1, failed: 0 });
    expect(readdirSync(dir)).toEqual(["t1.ndjson.gz"]);
    expect(gunzipped(dir, "t1.ndjson.gz")).toBe(body);
    expect(statSync(join(dir, "t1.ndjson.gz")).mtimeMs).toBeCloseTo(OLD, -3);
    expect(sweepNativeLogs(dir, { now: NOW })).toEqual({ rotated: 0, compressed: 0, skippedBusy: 0, failed: 0 });
  });

  it("rotates an oversized recent log without compressing it", () => {
    const dir = tmp();
    const body = frame(1).repeat(10);
    write(dir, "t1.ndjson", body, RECENT);
    const result = sweepNativeLogs(dir, { now: NOW, rotateBytes: CAP });
    expect(result).toMatchObject({ rotated: 1, compressed: 0 });
    expect(readFileSync(join(dir, "t1.1.ndjson"), "utf8")).toBe(body);
  });

  it("compresses idle fragments, and an oversized idle log rolls then compresses in one pass", () => {
    const dir = tmp();
    write(dir, "t1.1.ndjson", frame(0), OLD);
    const body = frame(1).repeat(10);
    write(dir, "t1.ndjson", body, OLD);
    const result = sweepNativeLogs(dir, { now: NOW, rotateBytes: CAP });
    expect(result).toMatchObject({ rotated: 1, compressed: 2, failed: 0 });
    expect(readdirSync(dir).sort()).toEqual(["t1.1.ndjson.gz", "t1.2.ndjson.gz"]);
    expect(gunzipped(dir, "t1.1.ndjson.gz")).toBe(frame(0));
    expect(gunzipped(dir, "t1.2.ndjson.gz")).toBe(body);
  });

  it("numbers a second compressed generation instead of clobbering the first .gz", () => {
    const dir = tmp();
    write(dir, "t1.ndjson.gz", gzipSync(frame(0)));
    const body = frame(1);
    write(dir, "t1.ndjson", body, OLD);
    const result = sweepNativeLogs(dir, { now: NOW });
    expect(result).toMatchObject({ compressed: 1, failed: 0 });
    expect(readdirSync(dir).sort()).toEqual(["t1.1.ndjson.gz", "t1.ndjson.gz"]);
    expect(gunzipped(dir, "t1.ndjson.gz")).toBe(frame(0));
    expect(gunzipped(dir, "t1.1.ndjson.gz")).toBe(body);
  });

  it("reports one bad file and still sweeps the rest", () => {
    const dir = tmp();
    mkdirSync(join(dir, "bad.ndjson"));
    utimesSync(join(dir, "bad.ndjson"), new Date(OLD), new Date(OLD));
    const body = frame(1);
    write(dir, "ok.ndjson", body, OLD);
    const result = sweepNativeLogs(dir, { now: NOW });
    expect(result).toMatchObject({ compressed: 1, failed: 1 });
    expect(gunzipped(dir, "ok.ndjson.gz")).toBe(body);
    expect(readdirSync(dir)).toContain("bad.ndjson");
  });

  it("ignores names that are not thread logs", () => {
    const dir = tmp();
    write(dir, "notes.txt", "hi", OLD);
    write(dir, "t1.ndjson.part", "x", OLD);
    const result = sweepNativeLogs(dir, { now: NOW, rotateBytes: CAP });
    expect(result).toEqual({ rotated: 0, compressed: 0, skippedBusy: 0, failed: 0 });
    expect(readdirSync(dir).sort()).toEqual(["notes.txt", "t1.ndjson.part"]);
  });
});
