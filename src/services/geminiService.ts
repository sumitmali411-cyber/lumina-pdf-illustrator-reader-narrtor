import { GoogleGenAI, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export async function getBackgroundPrompt(pageText: string, iteration: number = 1): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Analyze the following text from a book page and describe a highly detailed, cinematic, and artistic background image that captures the core essence and atmosphere of the scene. 
      
      ${iteration > 1 ? "This is a REFINEMENT. Make the previous concept more vivid, focusing on lighting, texture, and emotional depth." : ""}
      
      The description should be optimized for a high-end image generation model (like FLUX or Imagen). 
      Focus on:
      - Lighting (e.g., "golden hour glow", "moody chiaroscuro", "ethereal bioluminescence")
      - Style (e.g., "painterly impressionism", "hyper-realistic digital art", "vintage storybook illustration")
      - Composition (e.g., "wide angle landscape", "intimate close-up with bokeh")
      - Color Palette: Suggest colors that match the emotional tone.
      
      IMPORTANT: The image should be "atmospheric" and "artistic" but remain subtle enough to serve as a background for reading.
      
      Text: ${pageText.substring(0, 2500)}
      
      Return ONLY the descriptive image prompt.`,
    });
    
    return response.text || "A subtle greyish atmospheric minimalist background";
  } catch (error: any) {
    if (error?.message?.includes("429") || error?.message?.toLowerCase().includes("quota")) {
      throw new QuotaExceededError("API quota reached");
    }
    throw error;
  }
}

export async function generateBackgroundImage(prompt: string): Promise<string | null> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            text: `${prompt}. Atmospheric, artistic, high key, soft focus, ethereal, high quality digital art.`,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: "9:16",
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        console.log("Successfully generated background image");
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    console.warn("No image data found in Gemini response");
    return null;
  } catch (error: any) {
    if (error?.message?.includes("429") || error?.message?.toLowerCase().includes("quota")) {
      throw new QuotaExceededError("API quota reached");
    }
    console.error("Image generation failed:", error);
    return null;
  }
}

export async function generateSpeech(text: string, voice: 'Kore' | 'Fenrir' | 'Zephyr' = 'Kore'): Promise<string | null> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Read this book page with a professional and immersive voice: ${text.substring(0, 1000)}` }] }],
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
      // Gemini TTS returns raw PCM 16-bit, 24kHz. 
      // We need to wrap it in a WAV header for the browser to play it.
      const pcmData = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
      const wavHeader = createWavHeader(pcmData.length, 24000);
      const wavData = new Uint8Array(wavHeader.length + pcmData.length);
      wavData.set(wavHeader);
      wavData.set(pcmData, wavHeader.length);
      
      const blob = new Blob([wavData], { type: 'audio/wav' });
      return URL.createObjectURL(blob);
    }
    return null;
  } catch (error) {
    console.error("Speech generation failed:", error);
    return null;
  }
}

function createWavHeader(dataLength: number, sampleRate: number): Uint8Array {
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
