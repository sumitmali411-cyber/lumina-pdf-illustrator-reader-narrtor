
/**
 * Service for Offline Text-to-Speech using the Web Speech API.
 */

export interface SpeechOptions {
  onBoundary?: (index: number) => void;
  onEnd?: () => void;
  onError?: (error: any) => void;
  voice?: SpeechSynthesisVoice;
  rate?: number;
  pitch?: number;
}

class OfflineSpeechService {
  private synth: SpeechSynthesis | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
    }
  }

  public getVoices(): SpeechSynthesisVoice[] {
    if (!this.synth) return [];
    return this.synth.getVoices();
  }

  public speak(text: string, options: SpeechOptions = {}): void {
    if (!this.synth) {
      options.onError?.(new Error("Speech synthesis not supported"));
      return;
    }

    this.stop();

    const utterance = new SpeechSynthesisUtterance(text);
    
    if (options.voice) utterance.voice = options.voice;
    if (options.rate) utterance.rate = options.rate;
    if (options.pitch) utterance.pitch = options.pitch;

    utterance.onboundary = (event) => {
      if (event.name === 'word') {
        // Calculate word index based on character offset
        const textBefore = text.substring(0, event.charIndex);
        const wordsBefore = textBefore.trim().split(/\s+/).filter(w => w.length > 0);
        options.onBoundary?.(wordsBefore.length);
      }
    };

    utterance.onend = () => {
      this.currentUtterance = null;
      options.onEnd?.();
    };

    utterance.onerror = (event) => {
      this.currentUtterance = null;
      options.onError?.(event);
    };

    this.currentUtterance = utterance;
    this.synth.speak(utterance);
  }

  public pause(): void {
    this.synth?.pause();
  }

  public resume(): void {
    this.synth?.resume();
  }

  public stop(): void {
    this.synth?.cancel();
    this.currentUtterance = null;
  }

  public isSpeaking(): boolean {
    return this.synth?.speaking || false;
  }
}

export const offlineSpeech = new OfflineSpeechService();
