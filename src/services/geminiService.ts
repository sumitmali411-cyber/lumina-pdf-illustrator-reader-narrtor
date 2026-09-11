export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/**
 * Summarizes via the server-side proxy. The Gemini API key stays on the
 * server and is never exposed to the browser bundle.
 */
export async function summarizeText(text: string): Promise<string | null> {
  try {
    const response = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`Summarize failed with status ${response.status}`);
    const { summary } = (await response.json()) as { summary?: string | null };
    return summary || null;
  } catch (error) {
    console.error("Summarization failed:", error);
    return null;
  }
}

export async function generateSpeechPCM(text: string, voice: 'Kore' | 'Fenrir' | 'Zephyr' = 'Kore'): Promise<Uint8Array | null> {
  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });

    if (response.status === 429) {
      throw new QuotaExceededError("API quota reached");
    }

    if (!response.ok) {
      throw new Error(`Speech request failed with status ${response.status}`);
    }

    const { data } = (await response.json()) as { data?: string };
    if (!data) return null;

    // Reject anything that is not base64 before handing it to atob.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error("Server returned malformed audio data.");
    }

    return Uint8Array.from(atob(data), c => c.charCodeAt(0));
  } catch (error: any) {
    if (error instanceof QuotaExceededError) throw error;
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
