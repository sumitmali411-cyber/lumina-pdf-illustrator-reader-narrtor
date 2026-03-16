
/**
 * Service for interacting with Open Source / Open Weight models via Hugging Face Inference API.
 */

const HF_TOKEN = process.env.VITE_HUGGINGFACE_TOKEN || "";

export async function generateOpenImage(prompt: string): Promise<string | null> {
  try {
    // Using FLUX.1-schnell (Open Weight)
    const model = "black-forest-labs/FLUX.1-schnell";
    const response = await fetch(
      `https://api-inference.huggingface.co/models/${model}`,
      {
        headers: {
          Authorization: HF_TOKEN ? `Bearer ${HF_TOKEN}` : "",
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({ inputs: `${prompt}. Atmospheric, artistic, ethereal, soft focus.` }),
      }
    );

    if (!response.ok) {
      throw new Error(`HF Image API error: ${response.statusText}`);
    }

    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error("Open Source Image generation failed:", error);
    return null;
  }
}

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
