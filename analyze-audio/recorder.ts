#!/usr/bin/env ts-node

/**
 * Record & Analyze
 *
 * Records from the microphone. While recording, plays a random sound from
 * the /sounds folder each time noise is detected above the threshold.
 * Press Enter to stop — the recording is saved and the full analysis runs.
 *
 * Usage:
 *   ts-node analyze-audio/recorder.ts
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
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

// ─── Constants ────────────────────────────────────────────────────────────────

const SOUNDS_DIR      = path.resolve(path.join(__dirname, "..", "sounds"));
const PLAY_COOLDOWN_MS = 1500; // min ms between sound plays to avoid rapid-fire
const WINDOW_SAMPLES  = Math.floor((SAMPLE_RATE * DEFAULT_WINDOW_MS) / 1000);
const WINDOW_BYTES    = WINDOW_SAMPLES * BYTES_PER_SAMPLE;

// ─── Device Detection ─────────────────────────────────────────────────────────

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
    const match = line.match(/"([^"]+)"\s*\(audio\)/);
    if (match) devices.push(match[1]);
  }

  return devices;
}

// ─── Input Helper ─────────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

const waitForEnter = () => prompt("");

// ─── Sound Playback ───────────────────────────────────────────────────────────

let preconvertedWavs: string[] = [];
let lastPlayedAt = 0;

/**
 * Pre-converts every sound in SOUNDS_DIR to a temp WAV at startup.
 * Done once, synchronously, before recording begins — avoids any blocking
 * during the recording loop where spawnSync would freeze the event loop.
 */
function preconvertSounds(): void {
  if (!ffmpegPath || !fs.existsSync(SOUNDS_DIR)) return;

  const files = fs.readdirSync(SOUNDS_DIR)
    .filter((f: string) => /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f));
  if (files.length === 0) return;

  process.stdout.write(`Pre-converting ${files.length} sound(s)…`);

  for (const file of files) {
    const src = path.join(SOUNDS_DIR, file);
    const tmp = path.join(os.tmpdir(), `sleeper-snd-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const result = spawnSync(ffmpegPath, ["-v", "error", "-i", src, "-y", tmp]);
    if (result.status === 0) preconvertedWavs.push(tmp);
  }

  console.log(` done (${preconvertedWavs.length} ready).`);
}

/** Deletes all pre-converted temp WAVs. */
function cleanupSounds(): void {
  for (const f of preconvertedWavs) {
    try { fs.unlinkSync(f); } catch {}
  }
}

/**
 * Plays a random pre-converted WAV non-blocking.
 * Uses PowerShell's SoundPlayer.Play() which returns immediately.
 */
function playRandomSound(): void {
  if (preconvertedWavs.length === 0) return;

  const now = Date.now();
  if (now - lastPlayedAt < PLAY_COOLDOWN_MS) return;
  lastPlayedAt = now;

  const wav = preconvertedWavs[Math.floor(Math.random() * preconvertedWavs.length)];

  spawn(
    "powershell",
    ["-c", `(New-Object Media.SoundPlayer '${wav}').Play()`],
    { stdio: "ignore", detached: true }
  ).unref();
}

// ─── Recording ────────────────────────────────────────────────────────────────

function timestampedPath(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts  = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.resolve(path.join(__dirname, ".."), `recording_${ts}.wav`);
}

/**
 * Spawns ffmpeg with two outputs:
 *   1. Raw s16le PCM → stdout (for real-time analysis)
 *   2. WAV file      → outFile (for saving)
 */
function startRecording(device: string, outFile: string) {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found.");

  return spawn(
    ffmpegPath,
    [
      "-fflags", "nobuffer",   // minimise PCM output latency to stdout
      "-v", "error",
      "-f", "dshow", "-i", `audio=${device}`,
      // ── output 1: raw PCM to stdout ─────────────────────────────────────
      "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1",
      // ── output 2: WAV to file ────────────────────────────────────────────
      "-ar", String(SAMPLE_RATE), "-ac", "1", "-y", outFile,
    ],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
}

// ─── Real-time Noise Detection ────────────────────────────────────────────────

function attachNoiseDetector(stdout: NodeJS.ReadableStream): void {
  let buf      = Buffer.alloc(0);
  let wasNoise = false;

  stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= WINDOW_BYTES) {
      const win = buf.subarray(0, WINDOW_BYTES);
      buf = buf.subarray(WINDOW_BYTES);

      let sumSq = 0;
      for (let s = 0; s < WINDOW_SAMPLES; s++) {
        const sample = win.readInt16LE(s * BYTES_PER_SAMPLE);
        sumSq += sample * sample;
      }
      const rms = Math.sqrt(sumSq / WINDOW_SAMPLES);
      const db  = rms === 0 ? -Infinity : 20 * Math.log10(rms / 32768);
      const isNoise = db > DEFAULT_THRESHOLD_DBFS;

      // Play sound only on the transition from silence → noise
      if (isNoise && !wasNoise) playRandomSound();

      wasNoise = isNoise;
    }
  });
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

    console.log(`Decoded ${(fs.statSync(tmpFile).size / 1024 / 1024).toFixed(1)} MB  (${totalDurationSec.toFixed(2)} s)`);
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

  let device: string;

  if (devices.length === 1) {
    device = devices[0];
    console.log(`\nUsing: "${device}"`);
  } else {
    let choice = -1;
    while (choice < 1 || choice > devices.length) {
      const raw = await prompt(`\nSelect device [1–${devices.length}]: `);
      choice = parseInt(raw, 10);
      if (isNaN(choice) || choice < 1 || choice > devices.length)
        console.log(`  Please enter a number between 1 and ${devices.length}.`);
    }
    device = devices[choice - 1];
    console.log(`Using: "${device}"`);
  }

  const outFile = timestampedPath();
  console.log(`Output:  ${path.basename(outFile)}`);

  // Pre-convert sounds once before recording starts (blocking here is fine)
  preconvertSounds();

  const proc = startRecording(device, outFile);
  proc.on("error", err => { console.error(`\nRecording error: ${err.message}`); process.exit(1); });

  // Attach real-time noise detector to the PCM stdout stream
  attachNoiseDetector(proc.stdout!);

  console.log("\nRecording…  Press Enter to stop.\n");
  await waitForEnter();

  process.stdout.write("Stopping recording…");
  proc.stdin.write("q\n");
  proc.stdin.end();

  await new Promise<void>(resolve => proc.on("close", () => resolve()));
  console.log(" done.\n");

  if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    console.error("Recording failed — output file is missing or empty.");
    process.exit(1);
  }

  cleanupSounds();

  const sizeMB = fs.statSync(outFile).size / 1024 / 1024;
  console.log(`Saved: ${path.basename(outFile)}  (${sizeMB.toFixed(1)} MB)`);

  analyze(outFile);
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
