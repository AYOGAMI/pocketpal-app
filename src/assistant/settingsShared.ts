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
  followUp: boolean; // kept for older saves
  personaId: string; // 'default' or the id of one of your Pals
  conversation: 'one' | 'follow' | 'continuous';
  idleSeconds: number; // continuous mode: how long to wait in silence before closing
  keepModel: boolean; // continuous mode: keep the model loaded while the conversation lasts
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
  callOnMissed: boolean; // also text callers who hang up before the wait is over
  callAlways: boolean; // start the helper again after the phone restarts
  callMode: 'text' | 'answer'; // text = decline and text, answer = experimental AI answers the call
  callGreeting: string;
  callTurns: number;
  smsAgent: boolean; // the AI keeps texting the caller to get details
  smsMaxReplies: number;
  smsDetails: string;
  circleOnOpen: boolean;
  circleTarget: 'ask' | 'lens' | 'chooser' | 'save';
  circlePackage: string;
  glass: boolean; // frosted-glass look
  glassBlur: number;
  glassTint: 'app' | 'system'; // glass colour: PocketPal colours or the phone's theme
  glassRefract: number; // how much the glass bends what is behind it
};

export const DEFAULTS: AssistSettingsT = {
  skills: [],
  usePocketVoice: true,
  modelId: 'auto',
  unloadAfterAnswer: true,
  silenceMs: 750,
  followUp: true,
  personaId: 'default',
  conversation: 'follow',
  idleSeconds: 60,
  keepModel: true,
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
  callOnMissed: true,
  callAlways: true,
  callMode: 'text',
  callGreeting: "Hello, this is the phone assistant. The owner can't take your call right now. Please say your name and why you are calling.",
  callTurns: 2,
  smsAgent: true,
  smsMaxReplies: 3,
  smsDetails: "their name, why they called, how urgent it is, and the best number to call back",
  circleOnOpen: false,
  circleTarget: 'ask',
  circlePackage: '',
  glass: true,
  glassBlur: 25,
  glassTint: 'app',
  glassRefract: 14,
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
