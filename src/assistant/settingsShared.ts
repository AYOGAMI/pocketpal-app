import {NativeModules} from 'react-native';

// Assistant settings with their defaults. Saved natively so the call helper can read them too.
export type SkillT = {
  id: string;
  name: string;
  phrases: string; // trigger phrases, separated by commas
  type: 'app' | 'link' | 'say' | 'ai';
  value: string;
};

export type AssistSettingsT = {
  skills: SkillT[];
  usePocketVoice: boolean;
  modelId: string; // 'auto' = smallest downloaded model
  unloadAfterAnswer: boolean;
  silenceMs: number;
  followUp: boolean;
  showShade: boolean;
  showGlow: boolean;
  cloudSize: number; // 0.8 small, 1 normal, 1.25 big
  phoneActions: boolean;
  callSeconds: number;
  callDecline: boolean;
  callSms: boolean;
  callSmsText: string;
  callNote: boolean;
  callNotify: boolean;
};

export const DEFAULTS: AssistSettingsT = {
  skills: [],
  usePocketVoice: true,
  modelId: 'auto',
  unloadAfterAnswer: true,
  silenceMs: 750,
  followUp: true,
  showShade: true,
  showGlow: true,
  cloudSize: 1,
  phoneActions: true,
  callSeconds: 20,
  callDecline: true,
  callSms: true,
  callSmsText: "Hi, I'm busy right now. Please text me who you are and what it's about, and I'll get back to you.",
  callNote: true,
  callNotify: true,
};

const N: any = (NativeModules as any).AssistNative;

export async function loadSettings(): Promise<AssistSettingsT> {
  try {
    const raw = await N.getSettings();
    return {...DEFAULTS, ...JSON.parse(raw || '{}')};
  } catch (_e) {
    return {...DEFAULTS};
  }
}

export async function saveSettings(s: AssistSettingsT): Promise<void> {
  try {
    await N.setSettings(JSON.stringify(s));
  } catch (_e) {
    // ignore
  }
}
