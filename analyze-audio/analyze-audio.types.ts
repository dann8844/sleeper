/** Start of this window in milliseconds from file start */
export interface WindowResult {
  startMs: number;
  /** RMS level in dBFS (-∞ to 0) */
  db: number;
  /** Whether this window exceeded the configured threshold */
  isNoise: boolean;
}

export interface NoiseEvent {
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

export interface AnalysisReport {
  filePath: string;
  durationSec: number;
  sampleRate: number;
  windowMs: number;
  thresholdDb: number;
  silenceGapMs: number;

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
