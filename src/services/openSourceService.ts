
/**
 * Service for interacting with Open Source / Open Weight models via Hugging Face Inference API.
 */

const HF_TOKEN = process.env.VITE_HUGGINGFACE_TOKEN || "";

export async function generateOpenSpeech(text: string): Promise<string | null> {
  try {
    // Using Facebook's MMS TTS (Open Source)
    const model = "facebook/mms-tts-eng";
    const response = await fetch(
      `https://api-inference.huggingface.co/models/${model}`,
      {
        headers: {
          Authorization: HF_TOKEN ? `Bearer ${HF_TOKEN}` : "",
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({ inputs: text.substring(0, 500) }),
      }
    );

    if (!response.ok) {
      throw new Error(`HF Speech API error: ${response.statusText}`);
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (error) {
    console.error("Open Source Speech generation failed:", error);
    return null;
  }
}
