import OpenAI from "openai";
import { Uploadable } from "openai/uploads";
import fs, { ReadStream } from "fs";
import { logger } from "../utils/logger";
import AppError from "../errors/AppError";
import { bufferToReadStreamTmp } from "./bufferToReadStreamTmp";
import { convertAudioToOggOpus } from "./mediaConversion";

export type TranscriberAIOptions = {
  apiKey: string;
  provider?: string;
};

type providerOptions = {
  baseURL: string;
  model: string;
};

const supportedFormats = [
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "oga",
  "ogg",
  "wav",
  "webm"
];

const providerConfig: Record<string, providerOptions> = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe"
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo"
  }
};

/**
 * Transcribes audio using OpenAI's Whisper model.
 *
 * @param {ReadStream | Buffer | string} audioInput - The audio file to be transcribed.
 * @param {TranscriberAIOptions} options - The transcription options (apiKey, provider).
 * @param {string} [filename] - Optional filename to infer extension.
 * @returns {Promise<string | null>} - The transcribed text or null on failure.
 */
export const transcriber = async (
  audioInput: ReadStream | Buffer | string,
  { apiKey, provider }: TranscriberAIOptions,
  filename?: string
): Promise<string | null> => {
  if (!audioInput) {
    throw new AppError("No audio file provided");
  }

  if (!apiKey) {
    throw new AppError("No OpenAI API key provided");
  }

  const openai = new OpenAI({
    baseURL: providerConfig[provider]?.baseURL || undefined,
    apiKey
  });

  const extension = filename?.split(".").pop() || "ogg";

  let audio: Uploadable | any;

  try {
    if (!supportedFormats.includes(extension)) {
      const converted = await convertAudioToOggOpus(audioInput);
      audio = converted.data;
    } else if (typeof audioInput === "string") {
      if (audioInput.startsWith("http")) {
        const response = await fetch(audioInput);
        if (!response.ok) {
          const statusText = response?.statusText ?? String(response?.status ?? "unknown");
          logger.error({ statusText } as any, "Failed to fetch audio file");
          return null;
        }
        // openai accepts a Response stream for upload in some SDKs; keep as-is
        audio = response;
      } else {
        audio = fs.createReadStream(audioInput);
      }
    } else if (Buffer.isBuffer(audioInput)) {
      audio = bufferToReadStreamTmp(audioInput, extension);
    } else {
      // fallback: try to coerce to stream or reject
      logger.error({ audioInput } as any, "Unsupported audioInput type for transcriber");
      return null;
    }

    const transcription = await openai.audio.transcriptions.create({
      file: audio,
      model: providerConfig[provider]?.model || "whisper-1"
    });

    return transcription?.text ?? null;
  } catch (err: any) {
    // logger com objeto para evitar conflitos de tipos
    logger.error({ err } as any, "Error creating transcription");
    return null;
  }
};

