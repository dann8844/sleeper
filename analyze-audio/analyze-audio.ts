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
import { AnalysisReport, NoiseEvent, NoiseSequenceRow, WindowResult } from "./analyze-audio.types";
import { printOutput } from "./utils";

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE            = 8000;    // 8 kHz – native rate for AMR/phone audio
const CHANNELS               = 1;       // Mono simplifies RMS math
const BYTES_PER_SAMPLE       = 2;       // 16-bit signed PCM → 2 bytes
const MAX_AMPLITUDE          = 32768;   // 2^15 (16-bit signed full scale)
const DEFAULT_THRESHOLD_DBFS = -57;  // windows above this are counted as noise
const DEFAULT_WINDOW_MS      = 100;  // analysis frame length in milliseconds
const DEFAULT_SILENCE_GAP_MS  = 500;  // silence needed to close a noise event
const SEQUENCE_GAP_SEC        = 3;    // max gap between events to still be the same sequence
const DEFAULT_START_OFFSET_MIN = 30;   // skip this many minutes from the start
const DEFAULT_END_OFFSET_MIN   = 10;   // skip this many minutes from the end
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
 * Streams only the [startSec, endSec] slice of the PCM temp file.
 * Seeks directly to startSec so no time is wasted on skipped audio.
 */
function analyzeWindows(
  tmpFilePath: string,
  thresholdDb: number,
  windowMs: number,
  startSec: number,
  endSec: number
): WindowResult[] {
  const windowSamples = Math.floor((SAMPLE_RATE * windowMs) / 1000);
  const windowBytes   = windowSamples * BYTES_PER_SAMPLE;
  const results: WindowResult[] = [];

  // Align the start to a window boundary and seek there directly
  const startWindowIdx  = Math.floor((startSec * SAMPLE_RATE) / windowSamples);
  const startFileOffset = startWindowIdx * windowBytes;

  const fd      = fs.openSync(tmpFilePath, "r");
  const chunk   = Buffer.alloc(CHUNK_SIZE);
  let leftover  = Buffer.alloc(0);
  let windowIdx = startWindowIdx;
  let filePos   = startFileOffset;

  try {
    let bytesRead: number;

    while ((bytesRead = fs.readSync(fd, chunk, 0, CHUNK_SIZE, filePos)) > 0) {
      filePos += bytesRead;
      const data = Buffer.concat([leftover, chunk.subarray(0, bytesRead)]);
      const numCompleteWindows = Math.floor(data.length / windowBytes);

      for (let w = 0; w < numCompleteWindows; w++) {
        const winStartSec = (windowIdx * windowMs) / 1000;
        if (winStartSec >= endSec) break;

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

      leftover = data.subarray(numCompleteWindows * windowBytes);

      // Stop reading if we've passed the end
      if ((windowIdx * windowMs) / 1000 >= endSec) break;
    }
  } finally {
    fs.closeSync(fd);
  }

  return results;
}

/**
 * Group noise windows into events.
 * An event closes only after `silenceGapMs` of consecutive silence —
 * any loud window within the gap resets the counter and extends the event.
 */
function detectNoiseEvents(windows: WindowResult[], windowMs: number, silenceGapMs: number): NoiseEvent[] {
  const silenceGapWindows = Math.ceil(silenceGapMs / windowMs);
  const events: NoiseEvent[] = [];

  let inEvent       = false;
  let startSec      = 0;
  let peakDb        = -Infinity;
  let sumDb         = 0;
  let count         = 0;
  let silenceCount  = 0;      // consecutive silent windows since last noise
  let silenceStart  = 0;      // timestamp where current silence run began (seconds)

  const closeEvent = (endSec: number) => {
    events.push({ startSec, endSec, durationSec: endSec - startSec, peakDb, avgDb: sumDb / count });
    inEvent      = false;
    peakDb       = -Infinity;
    sumDb        = 0;
    count        = 0;
    silenceCount = 0;
  };

  for (const win of windows) {
    if (win.isNoise) {
      if (!inEvent) {
        inEvent   = true;
        startSec  = win.startMs / 1000;
      }
      // Loud window resets the silence counter — event stays open
      silenceCount = 0;
      if (win.db > peakDb) peakDb = win.db;
      sumDb += win.db;
      count++;
    } else if (inEvent) {
      if (silenceCount === 0) silenceStart = win.startMs / 1000;
      silenceCount++;
      // Only close the event once silence has lasted long enough
      if (silenceCount >= silenceGapWindows) closeEvent(silenceStart);
    }
  }

  // Close any event still open at end of file
  if (inEvent && windows.length > 0) {
    const endSec = silenceCount > 0 ? silenceStart : (windows[windows.length - 1].startMs + windowMs) / 1000;
    closeEvent(endSec);
  }

  return events;
}

/**
 * Groups noise events into sequences (events separated by < SEQUENCE_GAP_SEC).
 * Returns a frequency table sorted by noiseCount desc, then sequenceCount desc.
 */
function detectSequences(events: NoiseEvent[]): NoiseSequenceRow[] {
  if (events.length === 0) return [];

  // Walk events, recording the length and start time of each run
  const runs: { length: number; startSec: number }[] = [];
  let runLength  = 1;
  let runStartSec = events[0].startSec;

  for (let i = 1; i < events.length; i++) {
    const gap = events[i].startSec - events[i - 1].endSec;
    if (gap < SEQUENCE_GAP_SEC) {
      runLength++;
    } else {
      runs.push({ length: runLength, startSec: runStartSec });
      runLength   = 1;
      runStartSec = events[i].startSec;
    }
  }
  runs.push({ length: runLength, startSec: runStartSec });

  // Group by run length, collecting start times for each
  const freq = new Map<number, { sequenceCount: number; startTimes: number[] }>();
  for (const { length, startSec } of runs) {
    const entry = freq.get(length);
    if (entry) {
      entry.sequenceCount++;
      entry.startTimes.push(startSec);
    } else {
      freq.set(length, { sequenceCount: 1, startTimes: [startSec] });
    }
  }

  return Array.from(freq.entries())
    .map(([noiseCount, { sequenceCount, startTimes }]) => ({ noiseCount, sequenceCount, startTimes }))
    .sort((a, b) => b.noiseCount - a.noiseCount || b.sequenceCount - a.sequenceCount);
}

// ─── Report Building ──────────────────────────────────────────────────────────

function buildReport(
  filePath: string,
  windows: WindowResult[],
  events: NoiseEvent[],
  thresholdDb: number,
  windowMs: number,
  silenceGapMs: number,
  analyzeStartSec: number,
  analyzeEndSec: number,
  totalDurationSec: number
): AnalysisReport {
  const totalWindows      = windows.length;
  const durationSec       = analyzeEndSec - analyzeStartSec;
  const noiseWindows      = windows.filter((w) => w.isNoise);
  const totalNoiseTimeSec = (noiseWindows.length * windowMs) / 1000;
  const percentageNoise   = totalWindows > 0 ? (noiseWindows.length / totalWindows) * 100 : 0;
  const finiteDb          = windows.map((w) => w.db).filter(isFinite);
  const overallPeakDb     = finiteDb.reduce((max, v) => v > max ? v : max, -Infinity);
  const overallAvgDb      = finiteDb.length > 0
    ? finiteDb.reduce((sum, v) => sum + v, 0) / finiteDb.length
    : -Infinity;

  const sequences = detectSequences(events);

  return {
    filePath, durationSec, sampleRate: SAMPLE_RATE, windowMs, thresholdDb, silenceGapMs,
    analyzeStartSec, analyzeEndSec, totalDurationSec,
    overallPeakDb, overallAvgDb,
    noiseEventCount: events.length, totalNoiseTimeSec, percentageNoise,
    noiseEvents: events, windows, sequences,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const [, , audioPath, rawThreshold, rawWindowMs, rawSilenceGap, rawStartMin, rawEndMin] = process.argv;

  if (!audioPath) {
    console.error([
      "",
      "Usage:  ts-node analyze-audio/analyze-audio.ts <audio-file> [threshold-dBFS] [window-ms] [silence-gap-ms] [start-min] [end-offset-min]",
      "",
      "  audio-file       Any format supported by ffmpeg (mp3, wav, flac, amr, …)",
      "  threshold-dBFS   Windows above this level are counted as noise",
      `                   (default: ${DEFAULT_THRESHOLD_DBFS} dBFS)`,
      "  window-ms        Analysis frame length in milliseconds",
      `                   (default: ${DEFAULT_WINDOW_MS} ms)`,
      "  silence-gap-ms   Silence duration needed to close a noise event",
      `                   (default: ${DEFAULT_SILENCE_GAP_MS} ms)`,
      "  start-min        Skip this many minutes from the start",
      `                   (default: ${DEFAULT_START_OFFSET_MIN} min)`,
      "  end-offset-min   Skip this many minutes from the end",
      `                   (default: ${DEFAULT_END_OFFSET_MIN} min)`,
      "",
      "Examples:",
      "  ts-node analyze-audio/analyze-audio.ts recording.mp3",
      "  ts-node analyze-audio/analyze-audio.ts podcast.wav -30 100 500 30 10",
      "  ts-node analyze-audio/analyze-audio.ts interview.flac -25 100 1000 0 0",
      "",
    ].join("\n"));
    process.exit(1);
  }

  if (!fs.existsSync(audioPath)) {
    console.error(`Error: file not found – "${audioPath}"`);
    process.exit(1);
  }

  const thresholdDb    = rawThreshold !== undefined ? parseFloat(rawThreshold)    : DEFAULT_THRESHOLD_DBFS;
  const windowMs       = rawWindowMs  !== undefined ? parseInt(rawWindowMs,  10)  : DEFAULT_WINDOW_MS;
  const silenceGapMs   = rawSilenceGap !== undefined ? parseInt(rawSilenceGap, 10) : DEFAULT_SILENCE_GAP_MS;
  const startOffsetMin = rawStartMin  !== undefined ? parseFloat(rawStartMin)     : DEFAULT_START_OFFSET_MIN;
  const endOffsetMin   = rawEndMin    !== undefined ? parseFloat(rawEndMin)       : DEFAULT_END_OFFSET_MIN;

  if (isNaN(thresholdDb)) {
    console.error(`Error: invalid threshold "${rawThreshold}" – must be a number (e.g. -20)`);
    process.exit(1);
  }
  if (isNaN(windowMs) || windowMs < 1) {
    console.error(`Error: invalid window size "${rawWindowMs}" – must be a positive integer`);
    process.exit(1);
  }
  if (isNaN(silenceGapMs) || silenceGapMs < 1) {
    console.error(`Error: invalid silence gap "${rawSilenceGap}" – must be a positive integer`);
    process.exit(1);
  }
  if (isNaN(startOffsetMin) || startOffsetMin < 0) {
    console.error(`Error: invalid start offset "${rawStartMin}" – must be >= 0`);
    process.exit(1);
  }
  if (isNaN(endOffsetMin) || endOffsetMin < 0) {
    console.error(`Error: invalid end offset "${rawEndMin}" – must be >= 0`);
    process.exit(1);
  }

  console.log(`\nAnalyzing: ${audioPath}`);
  console.log("Decoding audio via ffmpeg…");

  let tmpFile: string | null = null;

  try {
    tmpFile = decodeToPCMFile(audioPath);

    const fileStat        = fs.statSync(tmpFile);
    const totalDurationSec = (fileStat.size / BYTES_PER_SAMPLE) / SAMPLE_RATE;
    const analyzeStartSec  = startOffsetMin * 60;
    const analyzeEndSec    = totalDurationSec - endOffsetMin * 60;

    if (analyzeStartSec >= analyzeEndSec) {
      console.error(`Error: analysis window is empty — start (${analyzeStartSec.toFixed(0)}s) >= end (${analyzeEndSec.toFixed(0)}s)`);
      process.exit(1);
    }

    const fileSizeMB = fileStat.size / 1024 / 1024;
    console.log(`Decoded ${fileSizeMB.toFixed(1)} MB  (${totalDurationSec.toFixed(2)} s of audio)`);
    console.log(`Analyzing ${(analyzeStartSec / 60).toFixed(1)}min → ${(analyzeEndSec / 60).toFixed(1)}min…`);

    const windows = analyzeWindows(tmpFile, thresholdDb, windowMs, analyzeStartSec, analyzeEndSec);
    const events  = detectNoiseEvents(windows, windowMs, silenceGapMs);
    const report  = buildReport(audioPath, windows, events, thresholdDb, windowMs, silenceGapMs, analyzeStartSec, analyzeEndSec, totalDurationSec);

    printOutput(report);
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

main();
