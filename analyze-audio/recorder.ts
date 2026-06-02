#!/usr/bin/env ts-node

/**
 * Record & Analyze
 *
 * Starts recording from the default microphone.
 * Press Enter to stop — the recording is saved and analyzed automatically.
 *
 * Usage:
 *   ts-node analyze-audio/recorder.ts
 *
 * Requirements:
 *   ffmpeg-static (bundled via npm)
 *   A working microphone (Windows: DirectShow)
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import ffmpegPath from "ffmpeg-static";

import {
  decodeToPCMFile,
  analyzeWindows,
  detectNoiseEvents,
  buildReport,
  DEFAULT_THRESHOLD_DBFS,
  DEFAULT_WINDOW_MS,
  DEFAULT_SILENCE_GAP_MS,
  DEFAULT_START_OFFSET_MIN,
  DEFAULT_END_OFFSET_MIN,
  BYTES_PER_SAMPLE,
  SAMPLE_RATE,
} from "./analyze-audio";
import { printOutput } from "./utils";

// ─── Device Detection ─────────────────────────────────────────────────────────

/**
 * Lists available DirectShow audio input devices on Windows.
 * Returns device names in order of appearance.
 */
function listAudioDevices(): string[] {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found.");

  const result = spawnSync(
    ffmpegPath,
    ["-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { maxBuffer: 1024 * 1024 }
  );

  const stderr = (result.stderr as Buffer).toString();
  const devices: string[] = [];

  for (const line of stderr.split("\n")) {
    // Each device appears as: "Device Name" (audio)
    const match = line.match(/"([^"]+)"\s*\(audio\)/);
    if (match) devices.push(match[1]);
  }

  return devices;
}

// ─── Input Helper ─────────────────────────────────────────────────────────────

/** Resolves when the user presses Enter. */
function waitForEnter(): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => { rl.close(); resolve(); });
  });
}

// ─── Recording ────────────────────────────────────────────────────────────────

/** Generates a timestamped WAV filename in the project root. */
function timestampedPath(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts  = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.resolve(path.join(__dirname, ".."), `recording_${ts}.wav`);
}

/** Starts ffmpeg recording from `device` into `outFile`. Returns the child process. */
function startRecording(device: string, outFile: string) {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found.");

  return spawn(
    ffmpegPath,
    ["-f", "dshow", "-i", `audio=${device}`, "-v", "error", "-y", outFile],
    { stdio: ["pipe", "ignore", "ignore"] }
  );
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

function analyze(audioPath: string): void {
  console.log("\nDecoding audio via ffmpeg…");

  let tmpFile: string | null = null;

  try {
    tmpFile = decodeToPCMFile(audioPath);

    const totalDurationSec = fs.statSync(tmpFile).size / BYTES_PER_SAMPLE / SAMPLE_RATE;
    const analyzeStartSec  = DEFAULT_START_OFFSET_MIN * 60;
    const analyzeEndSec    = totalDurationSec - DEFAULT_END_OFFSET_MIN * 60;

    console.log(`Decoded ${(fs.statSync(tmpFile).size / 1024 / 1024).toFixed(1)} MB  (${totalDurationSec.toFixed(2)} s of audio)`);
    console.log("Analyzing…");

    const windows = analyzeWindows(tmpFile, DEFAULT_THRESHOLD_DBFS, DEFAULT_WINDOW_MS, analyzeStartSec, analyzeEndSec);
    const events  = detectNoiseEvents(windows, DEFAULT_WINDOW_MS, DEFAULT_SILENCE_GAP_MS);
    const report  = buildReport(audioPath, windows, events, DEFAULT_THRESHOLD_DBFS, DEFAULT_WINDOW_MS, DEFAULT_SILENCE_GAP_MS, analyzeStartSec, analyzeEndSec, totalDurationSec);

    printOutput(report);
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found.");

  console.log("\nRECORD & ANALYZE\n");

  // Detect microphones
  process.stdout.write("Detecting audio input devices…");
  const devices = listAudioDevices();

  if (devices.length === 0) {
    console.error("\nNo audio input devices found. Check your microphone connection.");
    process.exit(1);
  }

  console.log(` found ${devices.length}:\n`);
  devices.forEach((d, i) => console.log(`  [${i + 1}]  ${d}`));

  const device = devices[0];
  console.log(`\nUsing: "${device}"`);

  // Prepare output file
  const outFile = timestampedPath();
  console.log(`Output:  ${path.basename(outFile)}\n`);

  // Start recording
  const proc = startRecording(device, outFile);

  proc.on("error", err => {
    console.error(`\nRecording error: ${err.message}`);
    process.exit(1);
  });

  console.log("Recording…  Press Enter to stop.\n");
  await waitForEnter();

  // Stop ffmpeg gracefully by sending 'q'
  process.stdout.write("Stopping recording…");
  proc.stdin.write("q\n");
  proc.stdin.end();

  await new Promise<void>(resolve => proc.on("close", () => resolve()));
  console.log(" done.\n");

  // Validate file
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    console.error("Recording failed — output file is missing or empty.");
    process.exit(1);
  }

  const sizeMB = fs.statSync(outFile).size / 1024 / 1024;
  console.log(`Saved: ${path.basename(outFile)}  (${sizeMB.toFixed(1)} MB)`);

  // Run analysis
  analyze(outFile);
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
