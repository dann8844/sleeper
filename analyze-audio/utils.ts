import * as path from "path";
import { AnalysisReport } from "./analyze-audio.types";

const fmtDb  = (n: number) => (isFinite(n) ? `${n.toFixed(2)} dBFS` : "-∞ dBFS");
const fmtSec = (s: number) => `${s.toFixed(3)} s`;
const fmtPct = (n: number) => `${n.toFixed(1)} %`;
const hr     = (char: string) => char.repeat(62);

/** Convert raw seconds to HH:MM:SS.mm */
const fmtTime = (s: number): string => {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};

export function printOutput(report: AnalysisReport): void {
  console.log("\n" + hr("═"));
  console.log("  AUDIO NOISE ANALYSIS REPORT");
  console.log(hr("═"));
  console.log(`  File             : ${path.basename(report.filePath)}`);
  console.log(`  Total duration   : ${fmtSec(report.totalDurationSec)}  (${fmtTime(report.totalDurationSec)})`);
  console.log(`  Analyzed range   : ${fmtTime(report.analyzeStartSec)}  →  ${fmtTime(report.analyzeEndSec)}  (${fmtSec(report.durationSec)})`);
  console.log(`  Sample rate      : ${report.sampleRate} Hz (resampled)`);
  console.log(`  Window size      : ${report.windowMs} ms`);
  console.log(`  Threshold        : ${fmtDb(report.thresholdDb)}`);
  console.log(`  Silence gap      : ${report.silenceGapMs} ms`);
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

  console.log("  EVENTS  (#  | starts at          | duration  | peak         | avg)");
  console.log(hr("─"));

  report.noiseEvents.forEach((e, i) => {
    const idx   = String(i + 1).padStart(4, " ");
    const start = `${fmtTime(e.startSec)}  (${fmtSec(e.startSec)})`.padEnd(28);
    const dur   = fmtSec(e.durationSec).padStart(9);
    const peak  = fmtDb(e.peakDb).padStart(12);
    const avg   = fmtDb(e.avgDb).padStart(12);
    console.log(`  #${idx}  | ${start} | ${dur} | ${peak} | ${avg}`);
  });

  console.log(hr("═"));

  // ── Sequence frequency table ───────────────────────────────────────────────
  console.log("\n  SEQUENCE FREQUENCY  (gap < 3 s between events)");
  console.log(hr("─"));

  if (report.sequences.length === 0) {
    console.log("  No sequences found.\n");
    return;
  }

  console.log("  Noises in sequence  |  Number of sequences");
  console.log(hr("─"));

  report.sequences.forEach(({ noiseCount, sequenceCount }) => {
    const col1 = String(noiseCount).padStart(18);
    const col2 = String(sequenceCount).padStart(20);
    console.log(`  ${col1}  |${col2}`);
  });

  console.log(hr("═") + "\n");
}
