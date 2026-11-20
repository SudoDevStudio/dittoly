import { useEffect, useRef, useState } from 'react';

/**
 * The browser's own speech recognition (Web Speech API), as the phone page uses it. Chrome, Edge and Safari have it
 * (Chrome sends the audio to Google to recognize it); Firefox does not, and then no microphone button is shown. It
 * listens in the browser's language: Punjabi comes out in Gurmukhi, which the AI reads as well as Roman script.
 */
export type Rec = {
  lang: string;
  interimResults: boolean;
  continuous?: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex?: number; results: ArrayLike<{ 0: { transcript: string }; isFinal?: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export function recognizer(): (new () => Rec) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return window.isSecureContext ? (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) : null;
}

/**
 * Speaking into a text box: what is said is added after what is already there, live while speaking, and stays for
 * the person to check and send. Nothing is sent by itself.
 */
export function useDictation(text: string, setText: (t: string) => void) {
  const Recognizer = recognizer();
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Rec | null>(null);
  useEffect(() => () => rec.current?.stop(), []);
  const toggle = () => {
    if (!Recognizer) return;
    if (listening) {
      rec.current?.stop();
      return;
    }
    const before = text.trim() ? `${text.trimEnd()} ` : '';
    const r = new Recognizer();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let said = '';
      for (let i = 0; i < e.results.length; i++) said += e.results[i]![0].transcript;
      setText(before + said.trim());
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setProblem('Allow the microphone for this page in your browser settings, or type instead.');
      else if (e.error === 'no-speech') setProblem('Nothing was heard. Try again closer to the microphone.');
      else if (e.error !== 'aborted') setProblem('Speech could not be recognized here. Type instead.');
    };
    r.onend = () => setListening(false);
    rec.current = r;
    setProblem(null);
    setListening(true);
    r.start();
  };
  const stop = () => rec.current?.stop();
  return { available: !!Recognizer, listening, toggle, stop, problem };
}
