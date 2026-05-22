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
 *   ts-node analyze-audio/analyze-audio.ts <audio-file> [threshold-dBFS] [window-ms]
 *
 * Examples:
 *   ts-node analyze-audio/analyze-audio.ts recording.mp3
 *   ts-node analyze-audio/analyze-audio.ts podcast.wav -30
 *   ts-node analyze-audio/analyze-audio.ts interview.flac -20 50
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegPath from "ffmpeg-static";
import { AnalysisReport, NoiseEvent, WindowResult } from "./analyze-audio.types";
import { printOutput } from "./utils";

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE            = 8000;    // 8 kHz – native rate for AMR/phone audio
const CHANNELS               = 1;       // Mono simplifies RMS math
const BYTES_PER_SAMPLE       = 2;       // 16-bit signed PCM → 2 bytes
const MAX_AMPLITUDE          = 32768;   // 2^15 (16-bit signed full scale)
const DEFAULT_THRESHOLD_DBFS = -57;  // windows above this are counted as noise
const DEFAULT_WINDOW_MS      = 100;  // analysis frame length in milliseconds
const CHUNK_SIZE                 = 64 * 1024 * 1024;  // 64 MB read chunks

// ─── Audio Decoding ───────────────────────────────────────────────────────────

/**
 * Runs ffmpeg to decode the input file into a raw s16le PCM temp file.
 * Returns the temp file path — caller is responsible for deleting it.
 */
function decodeToPCMFile(inputPath: string): string {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found.");

  const tmpFile = path.join(os.tmpdir(), `sleeper-pcm-${Date.now()}.raw`);

  const result = spawnSync(
    ffmpegPath,
    [
      "-v", "error",
      "-i", inputPath,
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-f", "s16le",
      "-y",
      tmpFile,
    ],
    { maxBuffer: 1024 * 1024 }  // only stderr flows through the pipe
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

  return tmpFile;
}

// ─── Signal Analysis ──────────────────────────────────────────────────────────

/** Convert a linear RMS value (0–32768) to dBFS */
function rmsToDbfs(rms: number): number {
  return rms === 0 ? -Infinity : 20 * Math.log10(rms / MAX_AMPLITUDE);
}

/**
 * Streams the PCM temp file in chunks and computes dBFS per window.
 * Never loads the full file into memory — safe for files of any size.
 */
function analyzeWindows(tmpFilePath: string, thresholdDb: number, windowMs: number): WindowResult[] {
  const windowSamples = Math.floor((SAMPLE_RATE * windowMs) / 1000);
  const windowBytes   = windowSamples * BYTES_PER_SAMPLE;
  const results: WindowResult[] = [];

  const fd      = fs.openSync(tmpFilePath, "r");
  const chunk   = Buffer.alloc(CHUNK_SIZE);
  let leftover  = Buffer.alloc(0);
  let windowIdx = 0;

  try {
    let bytesRead: number;

    while ((bytesRead = fs.readSync(fd, chunk, 0, CHUNK_SIZE, null)) > 0) {
      // Prepend any leftover bytes from the previous chunk
      const data = Buffer.concat([leftover, chunk.subarray(0, bytesRead)]);
      const numCompleteWindows = Math.floor(data.length / windowBytes);

      for (let w = 0; w < numCompleteWindows; w++) {
        const offset = w * windowBytes;
        let sumSq = 0;

        for (let s = 0; s < windowSamples; s++) {
          const sample = data.readInt16LE(offset + s * BYTES_PER_SAMPLE);
          sumSq += sample * sample;
        }

        const rms = Math.sqrt(sumSq / windowSamples);
        const db  = rmsToDbfs(rms);

        results.push({ startMs: windowIdx * windowMs, db, isNoise: db > thresholdDb });
        windowIdx++;
      }

      // Keep the partial window (if any) for the next iteration
      leftover = data.subarray(numCompleteWindows * windowBytes);
    }
  } finally {
    fs.closeSync(fd);
  }

  return results;
}

/** Group consecutive above-threshold windows into discrete noise events. */
function detectNoiseEvents(windows: WindowResult[], windowMs: number): NoiseEvent[] {
  const events: NoiseEvent[] = [];
  let inEvent = false;
  let startSec = 0;
  let peakDb = -Infinity;
  let sumDb = 0;
  let count = 0;

  const closeEvent = (endSec: number) => {
    events.push({ startSec, endSec, durationSec: endSec - startSec, peakDb, avgDb: sumDb / count });
    inEvent = false;
    peakDb = -Infinity;
    sumDb = 0;
    count = 0;
  };

  for (const win of windows) {
    if (win.isNoise) {
      if (!inEvent) { inEvent = true; startSec = win.startMs / 1000; }
      if (win.db > peakDb) peakDb = win.db;
      sumDb += win.db;
      count++;
    } else if (inEvent) {
      closeEvent(win.startMs / 1000);
    }
  }

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
  const totalWindows      = windows.length;
  const durationSec       = (totalWindows * windowMs) / 1000;
  const noiseWindows      = windows.filter((w) => w.isNoise);
  const totalNoiseTimeSec = (noiseWindows.length * windowMs) / 1000;
  const percentageNoise   = totalWindows > 0 ? (noiseWindows.length / totalWindows) * 100 : 0;
  const finiteDb          = windows.map((w) => w.db).filter(isFinite);
  const overallPeakDb     = finiteDb.reduce((max, v) => v > max ? v : max, -Infinity);
  const overallAvgDb      = finiteDb.length > 0
    ? finiteDb.reduce((sum, v) => sum + v, 0) / finiteDb.length
    : -Infinity;

  return {
    filePath, durationSec, sampleRate: SAMPLE_RATE, windowMs, thresholdDb,
    overallPeakDb, overallAvgDb,
    noiseEventCount: events.length, totalNoiseTimeSec, percentageNoise,
    noiseEvents: events, windows,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const [, , audioPath, rawThreshold, rawWindowMs] = process.argv;

  if (!audioPath) {
    console.error([
      "",
      "Usage:  ts-node analyze-audio/analyze-audio.ts <audio-file> [threshold-dBFS] [window-ms]",
      "",
      "  audio-file      Any format supported by ffmpeg (mp3, wav, flac, amr, …)",
      "  threshold-dBFS  Windows above this level are counted as noise",
      `                  (default: ${DEFAULT_THRESHOLD_DBFS} dBFS)`,
      "  window-ms       Analysis frame length in milliseconds",
      `                  (default: ${DEFAULT_WINDOW_MS} ms)`,
      "",
      "Examples:",
      "  ts-node analyze-audio/analyze-audio.ts recording.mp3",
      "  ts-node analyze-audio/analyze-audio.ts podcast.wav -30",
      "  ts-node analyze-audio/analyze-audio.ts interview.flac -25 50",
      "",
    ].join("\n"));
    process.exit(1);
  }

  if (!fs.existsSync(audioPath)) {
    console.error(`Error: file not found – "${audioPath}"`);
    process.exit(1);
  }

  const thresholdDb = rawThreshold !== undefined ? parseFloat(rawThreshold) : DEFAULT_THRESHOLD_DBFS;
  const windowMs    = rawWindowMs  !== undefined ? parseInt(rawWindowMs, 10) : DEFAULT_WINDOW_MS;

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

  let tmpFile: string | null = null;

  try {
    tmpFile = decodeToPCMFile(audioPath);

    const fileSizeMB  = fs.statSync(tmpFile).size / 1024 / 1024;
    const durationSec = (fs.statSync(tmpFile).size / BYTES_PER_SAMPLE) / SAMPLE_RATE;
    console.log(`Decoded ${fileSizeMB.toFixed(1)} MB  (${durationSec.toFixed(2)} s of audio)`);
    console.log("Analyzing windows…");

    const windows = analyzeWindows(tmpFile, thresholdDb, windowMs);
    const events  = detectNoiseEvents(windows, windowMs);
    const report  = buildReport(audioPath, windows, events, thresholdDb, windowMs);

    printOutput(report);
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

main();
