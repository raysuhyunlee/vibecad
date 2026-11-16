// Local speech to text: Whisper runs on this machine, so no audio leaves it.
import { homedir } from "node:os";
import { join } from "node:path";

// Small, not base: base mishears Korean. The timestamped export gives each word its time.
const MODEL = "onnx-community/whisper-small_timestamped";
const CACHE = join(homedir(), ".vibecad", "models");

export interface Word {
  text: string;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
}

type Asr = (audio: Float32Array, options: object) => Promise<{ chunks?: { text: string; timestamp: [number, number | null] }[] }>;
let asr: Promise<Asr> | undefined;
let ready = false;

export const voiceReady = () => ready;

/** Loads the model once, downloading it into ~/.vibecad/models on first use. A failed load is tried again next time. */
export function loadVoice(): Promise<Asr> {
  if (!asr) {
    asr = import("@huggingface/transformers").then(async ({ pipeline, env }) => {
      env.cacheDir = CACHE;
      const p = (await pipeline("automatic-speech-recognition", MODEL, { dtype: "q8" })) as unknown as Asr;
      ready = true;
      return p;
    });
    asr.catch(() => (asr = undefined));
  }
  return asr;
}

/** 16 kHz mono samples to words. `lang` is a language code such as "ko"; without one Whisper translates to English. */
export async function transcribe(audio: Float32Array, lang: string): Promise<Word[]> {
  if (audio.length === 0) return [];
  const r = await (await loadVoice())(audio, { language: lang, task: "transcribe", return_timestamps: "word", chunk_length_s: 30 });
  return (r.chunks ?? []).map((c) => ({ text: c.text, start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] }));
}
