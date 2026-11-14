import { execFile } from "node:child_process";
import { createWriteStream, readSync } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { RecordingTranscriptCue } from "@streamora/contracts";
import type { EnvironmentConfig } from "../../config/environment";
import type { FileStorageService } from "../files/file-storage.service";
import { safeErrorCode } from "../../common/safe-error-code";

const run = promisify(execFile);
const sampleRate = 16_000;
const durationLimitSeconds = 2 * 60 * 60;

class SpeechRecognitionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function stageError(stage: "STORAGE" | "FFMPEG", cause: unknown) {
  const code = safeErrorCode(cause);
  const name = cause instanceof Error ? cause.name : "";
  // AWS SDK service exceptions can expose their code as a named error.
  const detail =
    code !== "UNKNOWN"
      ? code
      : /^[A-Za-z][A-Za-z0-9]{1,31}$/.test(name) && name !== "Error"
        ? name.toUpperCase()
        : "FAILED";
  return new SpeechRecognitionError(`${stage}_${detail.slice(0, 36)}`);
}

export class TranscriptionInputError extends Error {
  constructor(readonly status: "TOO_LONG" | "FAILED") {
    super(status);
  }
}

async function recognizePcm(
  config: NonNullable<EnvironmentConfig["azureSpeech"]>,
  audio: string,
  size: number,
  signal: AbortSignal,
): Promise<RecordingTranscriptCue[]> {
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");
  const file = await open(audio, "r");
  try {
    signal.throwIfAborted();
    const speech = sdk.SpeechConfig.fromSubscription(config.key, config.region);
    speech.speechRecognitionLanguage = config.locales[0];
    const format = sdk.AudioStreamFormat.getWaveFormatPCM(sampleRate, 16, 1);
    let offset = 0;
    let readError: SpeechRecognitionError | undefined;
    const stream = sdk.AudioInputStream.createPullStream(
      {
        read(data) {
          if (signal.aborted || readError) return 0;
          try {
            const buffer = Buffer.from(data);
            const bytes = readSync(file.fd, buffer, 0, buffer.length, offset);
            offset += bytes;
            return bytes;
          } catch {
            readError = new SpeechRecognitionError(
              "RECORDING_AUDIO_READ_FAILED",
            );
            return 0;
          }
        },
        close() {},
      },
      format,
    );
    const input = sdk.AudioConfig.fromStreamInput(stream);
    try {
      // Detect the main spoken language once, then recognize every phrase in the file.
      const recognizer =
        config.locales.length === 1
          ? new sdk.SpeechRecognizer(speech, input)
          : sdk.SpeechRecognizer.FromConfig(
              speech,
              sdk.AutoDetectSourceLanguageConfig.fromLanguages(config.locales),
              input,
            );
      const cues: RecordingTranscriptCue[] = [];
      let abort = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) return abort();

          recognizer.recognized = (_, { result }) => {
            if (result.reason !== sdk.ResultReason.RecognizedSpeech) return;
            const text = result.text.trim();
            // Azure reports offsets and durations in 100 ns ticks.
            const startMs = Math.floor(result.offset / 10_000);
            const endMs = Math.ceil((result.offset + result.duration) / 10_000);
            if (
              text &&
              Number.isSafeInteger(startMs) &&
              Number.isSafeInteger(endMs) &&
              startMs >= 0 &&
              endMs > startMs
            )
              cues.push({ startMs, endMs, text });
          };
          recognizer.canceled = (_, event) => {
            if (event.reason !== sdk.CancellationReason.EndOfStream)
              reject(
                new SpeechRecognitionError(
                  `AZURE_SPEECH_CANCELED_${event.errorCode}`,
                ),
              );
          };
          recognizer.sessionStopped = () => {
            if (readError) reject(readError);
            else if (offset < size)
              reject(new SpeechRecognitionError("AZURE_SPEECH_INCOMPLETE"));
            else resolve();
          };
          recognizer.startContinuousRecognitionAsync(
            () => {},
            () =>
              reject(new SpeechRecognitionError("AZURE_SPEECH_START_FAILED")),
          );
        });
      } finally {
        signal.removeEventListener("abort", abort);
        // A stalled connection should not hold the worker past its job deadline.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 5000);
          const finish = () => {
            clearTimeout(timeout);
            resolve();
          };
          recognizer.close(finish, finish);
        });
      }
      return cues.sort((a, b) => a.startMs - b.startMs);
    } finally {
      // SDK 1.52.0 calls .then() on a void return when closing a pull stream via AudioConfig.
      stream.close();
      format.close();
    }
  } finally {
    await file.close();
  }
}

export async function transcribeRecording(
  config: NonNullable<EnvironmentConfig["azureSpeech"]>,
  storage: FileStorageService,
  file: { objectKey: string; storageLocationId: string | null },
  signal: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), "streamora-transcript-"));
  try {
    const video = join(directory, "recording");
    const audio = join(directory, "speech.pcm");
    try {
      const input = await storage.read(
        file.objectKey,
        file.storageLocationId,
        signal,
      );
      await pipeline(input, createWriteStream(video), { signal });
    } catch (error) {
      throw stageError("STORAGE", error);
    }
    // Only upload audio. Preserve the recording timeline, including leading silence.
    await run(
      config.ffmpegPath,
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,matroska,webm",
        "-i",
        video,
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        "aresample=async=1:first_pts=0",
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-c:a",
        "pcm_s16le",
        "-t",
        String(durationLimitSeconds),
        "-f",
        "s16le",
        audio,
      ],
      { signal },
    ).catch((error: unknown) => {
      throw stageError("FFMPEG", error);
    });
    const { size } = await stat(audio);
    if (size >= durationLimitSeconds * sampleRate * 2)
      throw new TranscriptionInputError("TOO_LONG");
    if (size === 0) return [];

    return await recognizePcm(config, audio, size, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
