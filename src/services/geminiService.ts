import { GoogleGenAI, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export async function summarizeText(text: string): Promise<string | null> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Summarize the following text from a book page concisely in 2-3 sentences. Capture the main events, ideas, or mood:\n\n${text.substring(0, 3000)}`
    });
    return response.text || null;
  } catch (error) {
    console.error("Summarization failed:", error);
    return null;
  }
}

export async function generateSpeechPCM(text: string, voice: 'Kore' | 'Fenrir' | 'Zephyr' = 'Kore'): Promise<Uint8Array | null> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      return Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
    }
    return null;
  } catch (error: any) {
    if (error?.message?.includes("429") || error?.message?.toLowerCase().includes("quota")) {
      throw new QuotaExceededError("API quota reached");
    }
    console.error("Speech generation failed:", error);
    return null;
  }
}

export async function generateSpeech(text: string, voice: 'Kore' | 'Fenrir' | 'Zephyr' = 'Kore'): Promise<string | null> {
  try {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const allTextChunks: string[] = [];
    let currentChunk = "";
    
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > 500) {
        if (currentChunk.trim()) allTextChunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += " " + sentence;
      }
    }
    if (currentChunk.trim()) allTextChunks.push(currentChunk.trim());

    const pcmChunks: Uint8Array[] = [];
    let totalPcmLength = 0;

    for (let i = 0; i < allTextChunks.length; i++) {
      const chunkText = allTextChunks[i];
      if (!chunkText) continue;

      let pcmData: Uint8Array | null = null;
      let retries = 3;
      while (retries > 0 && !pcmData) {
        try {
          pcmData = await generateSpeechPCM(`Read this text with a professional and immersive voice: ${chunkText}`, voice);
          if (!pcmData) throw new Error("Null PCM data");
        } catch (err) {
          retries--;
          if (retries === 0) {
            console.warn(`Failed to generate speech for chunk ${i}`);
          } else {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      if (pcmData) {
        pcmChunks.push(pcmData);
        totalPcmLength += pcmData.length;
      }
      
      await new Promise(r => setTimeout(r, 500));
    }

    if (pcmChunks.length > 0) {
      const wavHeader = createWavHeader(totalPcmLength, 24000);
      const wavData = new Uint8Array(wavHeader.length + totalPcmLength);
      wavData.set(wavHeader);
      
      let offset = wavHeader.length;
      for (const pcm of pcmChunks) {
        wavData.set(pcm, offset);
        offset += pcm.length;
      }
      
      const blob = new Blob([wavData], { type: 'audio/wav' });
      return URL.createObjectURL(blob);
    }
    return null;
  } catch (error) {
    console.error("Speech generation failed:", error);
    return null;
  }
}

export function createWavHeader(dataLength: number, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // file length
  view.setUint32(4, 36 + dataLength, true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw)
  view.setUint16(20, 1, true);
  // channel count
  view.setUint16(22, 1, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, sampleRate * 2, true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, dataLength, true);

  return new Uint8Array(header);
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
