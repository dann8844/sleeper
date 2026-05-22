#!/usr/bin/env ts-node

/**
 * Audio Noise Analyzer
 *
 * Decodes any audio file via ffmpeg, then sweeps through it in fixed-size
 * windows computing the RMS level (in dBFS). Consecutive windows that exceed
 * the threshold are grouped into a single "noise event".
 *
 * dBFS (decibels relative to Full Scale):
 *   0 dBFS  = maximum possible digital level
 *  -20 dBFS = roughly 10 % of full scale  ← default threshold
 *  -∞ dBFS  = complete silence
 *
 * Usage:
 *   ts-node analyze-audio.ts <audio-file> [threshold-dBFS] [window-ms]
 *
 * Examples:
 *   ts-node analyze-audio.ts recording.mp3
 *   ts-node analyze-audio.ts podcast.wav -30
 *   ts-node analyze-audio.ts interview.flac -20 50
 *
 * Requirements:
 *   ffmpeg must be installed and on your PATH.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 44100;    // Hz – all audio is resampled to this
const CHANNELS = 1;           // Mono simplifies RMS math
const BYTES_PER_SAMPLE = 2;   // 16-bit signed PCM → 2 bytes
const MAX_AMPLITUDE = 32768;  // 2^15 (16-bit signed full scale)

const DEFAULT_THRESHOLD_DBFS = -20;
const DEFAULT_WINDOW_MS = 100;  // analysis frame length in milliseconds

// ─── Types ────────────────────────────────────────────────────────────────────

interface WindowResult {
  /** Start of this window in milliseconds from file start */
  startMs: number;
  /** RMS level in dBFS (-∞ to 0) */
  db: number;
  /** Whether this window exceeded the configured threshold */
  isNoise: boolean;
}

interface NoiseEvent {
  /** Seconds from file start where this event begins */
  startSec: number;
  /** Seconds from file start where this event ends */
  endSec: number;
  /** Duration of the event in seconds */
  durationSec: number;
  /** Loudest window within this event (dBFS) */
  peakDb: number;
  /** Mean level across all windows in this event (dBFS) */
  avgDb: number;
}

interface AnalysisReport {
  filePath: string;
  durationSec: number;
  sampleRate: number;
  windowMs: number;
  thresholdDb: number;

  // Level summary
  overallPeakDb: number;
  overallAvgDb: number;

  // Noise summary
  noiseEventCount: number;
  totalNoiseTimeSec: number;
  percentageNoise: number;

  // Detail
  noiseEvents: NoiseEvent[];
  windows: WindowResult[];
}

// ─── Audio Decoding ───────────────────────────────────────────────────────────

/**
 * Runs ffmpeg to decode the input file into raw signed-16-bit little-endian
 * PCM at SAMPLE_RATE / CHANNELS and returns the data as a Node Buffer.
 */
function decodeToPCM(inputPath: string): Buffer {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v", "error",          // suppress info spam
      "-i", inputPath,
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-f", "s16le",          // signed 16-bit little-endian PCM
      "pipe:1",               // write to stdout
    ],
    { maxBuffer: 512 * 1024 * 1024 }  // up to ~512 MB of PCM (≈ 3 h of audio)
  );

  if (result.error) {
    throw new Error(
      `Could not run ffmpeg. Is it installed and on your PATH?\n  ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg exited with code ${result.status}:\n${result.stderr.toString().trim()}`
    );
  }

  return result.stdout as Buffer;
}

// ─── Signal Analysis ──────────────────────────────────────────────────────────

/** Convert a linear RMS value (0–32768) to dBFS */
function rmsToDbfs(rms: number): number {
  return rms === 0 ? -Infinity : 20 * Math.log10(rms / MAX_AMPLITUDE);
}

/**
 * Slice the PCM buffer into fixed-size windows and compute dBFS for each.
 */
function analyzeWindows(
  pcm: Buffer,
  thresholdDb: number,
  windowMs: number
): WindowResult[] {
  const windowSamples = Math.floor((SAMPLE_RATE * windowMs) / 1000);
  const windowBytes = windowSamples * BYTES_PER_SAMPLE;
  const numWindows = Math.floor(pcm.length / windowBytes);

  const results: WindowResult[] = [];

  for (let w = 0; w < numWindows; w++) {
    const offset = w * windowBytes;
    let sumSq = 0;

    for (let s = 0; s < windowSamples; s++) {
      const sample = pcm.readInt16LE(offset + s * BYTES_PER_SAMPLE);
      sumSq += sample * sample;
    }

    const rms = Math.sqrt(sumSq / windowSamples);
    const db = rmsToDbfs(rms);

    results.push({
      startMs: w * windowMs,
      db,
      isNoise: db > thresholdDb,
    });
  }

  return results;
}

/**
 * Group consecutive above-threshold windows into discrete noise events.
 */
function detectNoiseEvents(
  windows: WindowResult[],
  windowMs: number
): NoiseEvent[] {
  const events: NoiseEvent[] = [];

  let inEvent = false;
  let startSec = 0;
  let peakDb = -Infinity;
  let sumDb = 0;
  let count = 0;

  const closeEvent = (endSec: number) => {
    events.push({
      startSec,
      endSec,
      durationSec: endSec - startSec,
      peakDb,
      avgDb: sumDb / count,
    });
    inEvent = false;
    peakDb = -Infinity;
    sumDb = 0;
    count = 0;
  };

  for (const win of windows) {
    if (win.isNoise) {
      if (!inEvent) {
        inEvent = true;
        startSec = win.startMs / 1000;
      }
      if (win.db > peakDb) peakDb = win.db;
      sumDb += win.db;
      count++;
    } else if (inEvent) {
      closeEvent(win.startMs / 1000);
    }
  }

  // Close an event that runs to the very end of the file
  if (inEvent && windows.length > 0) {
    const last = windows[windows.length - 1];
    closeEvent((last.startMs + windowMs) / 1000);
  }

  return events;
}

// ─── Report Building ──────────────────────────────────────────────────────────

function buildReport(
  filePath: string,
  windows: WindowResult[],
  events: NoiseEvent[],
  thresholdDb: number,
  windowMs: number
): AnalysisReport {
  const totalWindows = windows.length;
  const durationSec = (totalWindows * windowMs) / 1000;

  const noiseWindows = windows.filter((w) => w.isNoise);
  const totalNoiseTimeSec = (noiseWindows.length * windowMs) / 1000;
  const percentageNoise =
    totalWindows > 0 ? (noiseWindows.length / totalWindows) * 100 : 0;

  const finiteDb = windows.map((w) => w.db).filter(isFinite);
  const overallPeakDb = finiteDb.length > 0 ? Math.max(...finiteDb) : -Infinity;
  const overallAvgDb =
    finiteDb.length > 0
      ? finiteDb.reduce((a, b) => a + b, 0) / finiteDb.length
      : -Infinity;

  return {
    filePath,
    durationSec,
    sampleRate: SAMPLE_RATE,
    windowMs,
    thresholdDb,
    overallPeakDb,
    overallAvgDb,
    noiseEventCount: events.length,
    totalNoiseTimeSec,
    percentageNoise,
    noiseEvents: events,
    windows,
  };
}

// ─── Console Output ───────────────────────────────────────────────────────────

function printReport(report: AnalysisReport): void {
  const fmtDb = (n: number) =>
    isFinite(n) ? `${n.toFixed(2)} dBFS` : "-∞ dBFS";
  const fmtSec = (s: number) => `${s.toFixed(3)} s`;
  const fmtPct = (n: number) => `${n.toFixed(1)} %`;

  const hr = (char: string) => char.repeat(62);

  console.log("\n" + hr("═"));
  console.log("  AUDIO NOISE ANALYSIS REPORT");
  console.log(hr("═"));
  console.log(`  File             : ${path.basename(report.filePath)}`);
  console.log(`  Duration         : ${fmtSec(report.durationSec)}`);
  console.log(`  Sample rate      : ${report.sampleRate} Hz (resampled)`);
  console.log(`  Window size      : ${report.windowMs} ms`);
  console.log(`  Threshold        : ${fmtDb(report.thresholdDb)}`);
  console.log(hr("─"));
  console.log(`  Peak level       : ${fmtDb(report.overallPeakDb)}`);
  console.log(`  Average level    : ${fmtDb(report.overallAvgDb)}`);
  console.log(hr("─"));
  console.log(`  Noise events     : ${report.noiseEventCount}`);
  console.log(`  Total noise time : ${fmtSec(report.totalNoiseTimeSec)}`);
  console.log(`  Noise coverage   : ${fmtPct(report.percentageNoise)}`);
  console.log(hr("─"));

  if (report.noiseEvents.length === 0) {
    console.log("  No noise events detected above threshold.\n");
    return;
  }

  console.log("  EVENTS  (start → end | duration | peak | avg)");
  console.log(hr("─"));

  report.noiseEvents.forEach((e, i) => {
    const idx = String(i + 1).padStart(4, " ");
    const start = fmtSec(e.startSec).padStart(10);
    const end = fmtSec(e.endSec).padStart(10);
    const dur = fmtSec(e.durationSec).padStart(9);
    const peak = fmtDb(e.peakDb).padStart(12);
    const avg = fmtDb(e.avgDb).padStart(12);
    console.log(`  #${idx}  ${start} → ${end} | ${dur} | ${peak} | ${avg}`);
  });

  console.log(hr("═") + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const [, , audioPath, rawThreshold, rawWindowMs] = process.argv;

  if (!audioPath) {
    console.error(
      [
        "",
        "Usage:  ts-node analyze-audio.ts <audio-file> [threshold-dBFS] [window-ms]",
        "",
        "  audio-file      Any format supported by ffmpeg (mp3, wav, flac, …)",
        "  threshold-dBFS  Level above which a window is counted as noise",
        `                  (default: ${DEFAULT_THRESHOLD_DBFS} dBFS)`,
        "  window-ms       Analysis frame length in milliseconds",
        `                  (default: ${DEFAULT_WINDOW_MS} ms)`,
        "",
        "Examples:",
        "  ts-node analyze-audio.ts recording.mp3",
        "  ts-node analyze-audio.ts podcast.wav -30",
        "  ts-node analyze-audio.ts interview.flac -25 50",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  if (!fs.existsSync(audioPath)) {
    console.error(`Error: file not found – "${audioPath}"`);
    process.exit(1);
  }

  const thresholdDb = rawThreshold !== undefined
    ? parseFloat(rawThreshold)
    : DEFAULT_THRESHOLD_DBFS;

  const windowMs = rawWindowMs !== undefined
    ? parseInt(rawWindowMs, 10)
    : DEFAULT_WINDOW_MS;

  if (isNaN(thresholdDb)) {
    console.error(`Error: invalid threshold "${rawThreshold}" – must be a number (e.g. -20)`);
    process.exit(1);
  }
  if (isNaN(windowMs) || windowMs < 1) {
    console.error(`Error: invalid window size "${rawWindowMs}" – must be a positive integer`);
    process.exit(1);
  }

  console.log(`\nAnalyzing: ${audioPath}`);
  console.log("Decoding audio via ffmpeg…");

  const pcm = decodeToPCM(audioPath);
  const totalSamples = pcm.length / BYTES_PER_SAMPLE;
  const decodedSec = totalSamples / SAMPLE_RATE;
  console.log(`Decoded ${(pcm.length / 1024 / 1024).toFixed(1)} MB  (${decodedSec.toFixed(2)} s of audio)`);
  console.log("Analyzing windows…");

  const windows = analyzeWindows(pcm, thresholdDb, windowMs);
  const events = detectNoiseEvents(windows, windowMs);
  const report = buildReport(audioPath, windows, events, thresholdDb, windowMs);

  printReport(report);
}

main();
