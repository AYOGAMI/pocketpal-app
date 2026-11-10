import React, {useEffect, useRef, useState} from 'react';
import {
  Animated,
  AppState,
  DeviceEventEmitter,
  BackHandler,
  Dimensions,
  Easing,
  Image,
  NativeEventEmitter,
  NativeModules,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
  requireNativeComponent,
} from 'react-native';

import {asrStore, modelStore, palStore, ttsStore} from '../store';
import {whisperAsrEngine} from '../services/asr';
import {ttsRuntime} from '../services/tts';

import {AssistSettingsT, DEFAULTS, SkillT, loadSettings} from './settingsShared';

// PocketPal assistant: a small transparent living cloud at the bottom of the screen.
// It listens, understands what you want, runs phone actions (apps, maps, alarms, mail...)
// or answers with the on-device model. Every model is unloaded as soon as it is not needed.

const N: any = (NativeModules as any).AssistNative;

// Saves fatal app errors to the Downloads folder (pocketpal-crash-*.txt) so they can be read from Termux.
try {
  const EU: any = (global as any).ErrorUtils;
  if (EU && !(global as any).__pp_crash_logger) {
    (global as any).__pp_crash_logger = true;
    const prevHandler = EU.getGlobalHandler?.();
    EU.setGlobalHandler((e: any, fatal?: boolean) => {
      try {
        N?.writeCrash('JS error (fatal=' + fatal + ')\n' + String(e?.stack ?? e?.message ?? e));
      } catch (_x) {
        // ignore
      }
      if (prevHandler) {
        prevHandler(e, fatal);
      }
    });
  }
} catch (_e) {
  // ignore
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Phase = 'starting' | 'listening' | 'thinking' | 'speaking';
type Msg = {role: 'user' | 'assistant'; content: string};

// ---------------------------------------------------------------- loading and unloading
let S: AssistSettingsT = DEFAULTS;
let PERSONA = '';
const unloadEach = () => S.unloadAfterAnswer && !(S.conversation === 'continuous' && S.keepModel);
let sessionOver = false;
let assistActive = false;
let baselineCtx = false;
let baselineFlags: {was: boolean; id: any} = {was: false, id: undefined};

const guard = (p: Promise<any>, ms: number): Promise<any> =>
  Promise.race([p.catch(() => {}), sleep(ms)]);

// While the panel is open the app must not reload "its" model behind our back.
try {
  const ms0: any = modelStore;
  const orig = ms0.checkAndReloadAutoReleasedModel;
  if (typeof orig === 'function' && !ms0.__assistPatched) {
    ms0.__assistPatched = true;
    ms0.checkAndReloadAutoReleasedModel = (...args: any[]) =>
      assistActive ? Promise.resolve() : orig.apply(ms0, args);
  }
} catch (_e) {
  // the store does not allow it; ownership by baseline below still unloads the model
}

function beginSession() {
  const ms: any = modelStore;
  sessionOver = false;
  assistActive = true;
  baselineCtx = !!ms.context && !ms.isContextLoading; // loaded by the app before we started: never ours
  baselineFlags = {was: !!ms.wasAutoReleased, id: ms.lastAutoReleasedModelId};
}

// Unloads any model that was loaded during this session (by us or by the app waking up).
async function offloadModel() {
  const ms: any = modelStore;
  if (baselineCtx) {
    return;
  }
  for (let i = 0; i < 200 && ms.isContextLoading; i++) {
    await sleep(150);
  }
  if (ms.context) {
    try {
      await ms.releaseContext();
    } catch (_e) {
      // ignore
    }
    if (baselineFlags.was) {
      try {
        ms.markAutoReleased?.(baselineFlags.id ?? ms.activeModelId);
      } catch (_e) {
        // ignore
      }
    }
  }
}

// Loads the smallest downloaded model (less memory, less battery, other apps are not killed).
async function ensureModel(): Promise<boolean> {
  const ms: any = modelStore;
  for (let i = 0; i < 200 && ms.isContextLoading; i++) {
    await sleep(150);
  }
  if (ms.context) {
    return true;
  }
  for (let i = 0; i < 40 && !(ms.models && ms.models.length > 0); i++) {
    await sleep(150);
  }
  const list: any[] = ms.models ?? [];
  const downloaded = list.filter(m => m.isDownloaded);
  const sized = downloaded
    .filter(m => typeof m.size === 'number' && m.size > 0)
    .sort((a, b) => a.size - b.size);
  const id = ms.lastUsedModelId ?? ms.activeModelId ?? ms.lastAutoReleasedModelId;
  const chosen = S.modelId !== 'auto' ? list.find(m => m.id === S.modelId && m.isDownloaded) : undefined;
  const model = chosen ?? sized[0] ?? list.find(m => m.id === id) ?? downloaded[0];
  if (!model) {
    return false;
  }
  try {
    await ms.initContext(model);
  } finally {
    if (sessionOver) {
      await offloadModel(); // the panel was closed while the model was still loading
    }
  }
  return !!ms.context;
}

let whisperLoaded = false;
async function loadWhisper(tier: any) {
  if (!whisperLoaded) {
    await whisperAsrEngine.preload(tier);
    whisperLoaded = true;
  }
}
async function unloadWhisper() {
  if (whisperLoaded) {
    whisperLoaded = false;
    try {
      await whisperAsrEngine.release();
    } catch (_e) {
      // ignore
    }
  }
}
async function unloadVoice() {
  try {
    await (ttsRuntime as any).release();
  } catch (_e) {
    // ignore
  }
}

// ---------------------------------------------------------------- PocketPal's own voice
// Filled in at build time from the app's own TTSStore.play signature, e.g. ['id','text'].
const PLAY_ARGS: string[] = ['id', 'text', 'other']; // generated

const isPlaying = () => {
  const mode = (ttsStore as any).playbackState?.mode;
  return !!mode && mode !== 'idle';
};

async function waitIdle(maxMs: number) {
  const t0 = Date.now();
  while (isPlaying() && Date.now() - t0 < maxMs) {
    await sleep(120);
  }
}

// Speaks with the voice chosen in PocketPal. Returns false if that was not possible.
async function speakApp(text: string): Promise<boolean> {
  const t: any = ttsStore;
  if (!S.usePocketVoice || !PLAY_ARGS.includes('text') || !t?.currentVoice || typeof t.play !== 'function') {
    return false;
  }
  try {
    const args = PLAY_ARGS.map(k => (k === 'text' ? text : k === 'id' ? 'assistant-' + Date.now() : undefined));
    const p = Promise.resolve(t.play(...args));
    p.catch(() => {});
    let started = false;
    for (let i = 0; i < 40 && !started; i++) {
      await sleep(100);
      started = isPlaying();
    }
    if (!started) {
      try {
        await guard(t.stop('assistant'), 1500);
      } catch (_e) {
        // ignore
      }
      return false;
    }
    await waitIdle(90000);
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------- quick intent rules
const WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  fifteen: '15', twenty: '20', thirty: '30', forty: '40', 'forty five': '45',
  fortyfive: '45', sixty: '60',
};

const digits = (t: string) =>
  t.replace(
    /\b(forty five|fortyfive|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty)\b/g,
    w => WORDS[w] ?? w,
  );

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.,!?"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const LAUNCHING = ['open_url', 'open_app', 'navigate', 'search', 'music', 'camera', 'settings', 'call', 'sms', 'email'];

// Your own skills from the settings screen.
function matchSkill(text: string): {skill: SkillT; rest: string} | null {
  const t = clean(text);
  for (const sk of S.skills ?? []) {
    const phrases = String(sk.phrases ?? '')
      .split(/[,\n]/)
      .map(p => clean(p))
      .filter(Boolean);
    for (const p of phrases) {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp('(^|\\s)' + esc + '(\\s|$)').exec(t);
      if (m) {
        const rest = t.slice(m.index + m[0].length).replace(/^(for|to|about)\s+/, '').trim();
        return {skill: sk, rest};
      }
    }
  }
  return null;
}

function skillAct(hit: {skill: SkillT; rest: string}, fullText: string): any {
  const v = hit.skill.value;
  if (hit.skill.type === 'app') {
    return {a: 'open_app', app: v};
  }
  if (hit.skill.type === 'link') {
    return {a: 'open_url', url: v.split('{q}').join(encodeURIComponent(hit.rest))};
  }
  if (hit.skill.type === 'say') {
    return {say: v};
  }
  return {a: 'skill_ai', instruction: v, input: hit.rest || fullText};
}

function ruleIntent(raw: string): any | null {
  let t = clean(raw);
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(
        /^(hey|ok|okay|please|can you|could you|would you|will you|i want you to|i want to|i wanna|just|go ahead and)\s+/,
        '',
      )
      .trim();
  }
  t = t.replace(/\s+(please|for me|now)$/, '').trim();
  let m: RegExpMatchArray | null;

  if (/^(cancel|stop|never ?mind|close|dismiss|bye|goodbye|that s all|thank you|thanks)$/.test(t)) {
    return {a: 'close'};
  }
  if (
    (m =
      t.match(/^(?:write|draft|compose|create|send|prepare)(?: me)?(?: an?| the)? (?:e ?mail|mail)(?: to (.+?))?(?: (?:about|saying|that says|regarding|telling|asking|to say|for|that|which says) (.+))?$/) ||
      t.match(/^(?:e ?mail|mail) (.+?)(?: (?:about|saying|regarding|telling|asking|that) (.+))?$/))
  ) {
    return {a: 'email', to: (m[1] ?? '').trim(), topic: (m[2] ?? '').trim()};
  }
  if (/take (a )?(screen ?shot|screen shot)|^screen ?shot$|capture (the |my )?screen/.test(t)) {
    return {a: 'screenshot'};
  }
  if (/circle (to )?search|(search|lens|identify|what is) (this|that|what s) (on|in) (my |the )?screen|search (this|that)$|google lens/.test(t)) {
    return {a: 'circle'};
  }
  if (/(unload|offload|free up|free) (the )?(model|memory|ai)|turn off (the )?(model|ai)/.test(t)) {
    return {a: 'unload'};
  }
  if (/(call (helper|screening|screener|assistant|answering)|screen (my )?calls|auto (decline|reject) (my )?calls)/.test(t)) {
    return {a: 'callhelper', on: !/\b(off|stop|disable|cancel)\b/.test(t)};
  }
  if (/(notification|notifications|notifs)/.test(t) && /(read|check|summari|what|any|show|tell)/.test(t)) {
    return {a: 'notifs'};
  }
  if (/(view|look at|see|describe|what s on|what is on|tell me what s on|show me what s on) (my |the )?(screen|display)/.test(t)) {
    return {a: 'vision'};
  }
  if ((/(screen|page)/.test(t) && /(read|summari|explain)/.test(t)) || /^(summari[sz]e|read|explain) (this|it)$/.test(t)) {
    return {a: 'screen'};
  }
  if (/^(?:read|show|what are)(?: me)?(?: all)? my notes$/.test(t)) {
    return {a: 'notes_read'};
  }
  if (/^(?:clear|delete)(?: all)? my notes$/.test(t)) {
    return {a: 'notes_clear'};
  }
  if ((m = t.match(/^(?:take|add|make|write|save)(?: me)?(?: a)? note(?: that| saying| to)?\s*(.*)$/) || t.match(/^remember (?:that )?(.+)$/))) {
    return {a: 'note_add', text: (m[1] ?? '').trim()};
  }
  if (/what (is|s) the time|^what time is it|tell me the time|^time$/.test(t)) {
    return {say: 'It is ' + new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})};
  }
  if (/what (is|s) (the )?(date|day)|what day is it|today s date/.test(t)) {
    return {
      say:
        'Today is ' +
        new Date().toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'}),
    };
  }
  if (/battery/.test(t)) {
    return {a: 'battery'};
  }
  const d = digits(t);
  if (
    (m =
      d.match(/(\d+)\s*(second|sec|minute|min|hour|hr)s?\s*timer/) ||
      d.match(/timer\s*(?:for|of)?\s*(\d+)\s*(second|sec|minute|min|hour|hr)s?/))
  ) {
    const n = parseInt(m[1], 10);
    const u = m[2];
    const secs = /^h/.test(u) ? n * 3600 : /^(m)/.test(u) ? n * 60 : n;
    return {a: 'timer', seconds: secs};
  }
  if (/alarm|wake me/.test(d)) {
    const tm = d.match(/(\d{1,2})(?:[: ](\d{2}))?\s*(a m|p m|am|pm)?/);
    if (tm) {
      let h = parseInt(tm[1], 10);
      const mi = tm[2] ? parseInt(tm[2], 10) : 0;
      const ap = (tm[3] ?? '').replace(' ', '');
      if (ap === 'pm' && h < 12) {
        h += 12;
      }
      if (ap === 'am' && h === 12) {
        h = 0;
      }
      if (h <= 23 && mi <= 59) {
        return {a: 'alarm', h, m: mi, label: 'PocketPal'};
      }
    }
    return {say: 'What time should I set the alarm for?'};
  }
  if (/flash ?light|torch/.test(t)) {
    return {a: 'flashlight', on: !/\boff\b/.test(t)};
  }
  if (/\b(camera|selfie)\b|take a (photo|picture)/.test(t)) {
    return {a: 'camera'};
  }
  if (
    (m =
      t.match(/^(?:navigate|navigation|directions?|drive|take me|route)(?: me)?(?: to| for)? (.+)$/) ||
      t.match(/(?:how (?:do i|can i|to) get to|where is|find) (.+)/))
  ) {
    return {a: 'navigate', to: m[1]};
  }
  if ((m = t.match(/^(?:text|message|sms)\s+(.+?)\s+(?:saying|that says|say|to say)\s+(.+)$/))) {
    return {a: 'sms', who: m[1], text: m[2]};
  }
  if ((m = t.match(/^(?:call|phone|dial|ring)\s+(.+)$/))) {
    return {a: 'call', who: m[1]};
  }
  if (/(wi ?fi|bluetooth|airplane|location|brightness|display|sound)/.test(t) &&
      /(open|turn|switch|enable|disable|toggle|settings)/.test(t)) {
    const page = /wi ?fi/.test(t) ? 'wifi'
      : /bluetooth/.test(t) ? 'bluetooth'
      : /airplane/.test(t) ? 'airplane'
      : /location/.test(t) ? 'location'
      : /sound/.test(t) ? 'sound' : 'display';
    return {a: 'settings', page};
  }
  if (/(volume|louder|quieter|unmute|\bmute\b)/.test(t)) {
    const dir = /\bmax|full/.test(t) ? 'max'
      : /\bmute\b/.test(t) && !/unmute/.test(t) ? 'mute'
      : /down|quieter|lower|decrease|reduce/.test(t) ? 'down' : 'up';
    return {a: 'volume', dir};
  }
  if ((m = t.match(/^(?:search the web for|search for|search|google|look up)\s+(.+)$/))) {
    return {a: 'search', q: m[1]};
  }
  if ((m = t.match(/^play\s+(.+?)(?:\s+on\s+(?:youtube|spotify|music|youtube music))?$/))) {
    return {a: 'music', q: m[1]};
  }
  if ((m = t.match(/^(?:open|launch|start|run|go to)\s+(.+)$/))) {
    return {a: 'open_app', app: m[1].replace(/^(the|my)\s+/, '').replace(/\s+app$/, '')};
  }
  return null;
}

// ---------------------------------------------------------------- the model as the brain
const SYSTEM =
  'You are PocketPal, a friendly voice assistant on an Android phone. Answer in one or two short spoken sentences. No markdown, no lists. ' +
  'If the user wants the phone to DO something, reply with exactly one line: ACTION {"a":"<name>", ...}. Actions: ' +
  'open_app{"app"}, navigate{"to"}, alarm{"h":0-23,"m":0-59}, timer{"seconds"}, call{"who"}, sms{"who","text"}, ' +
  'email{"to","topic"}, flashlight{"on":true|false}, search{"q"}, music{"q"}, ' +
  'settings{"page":"wifi|bluetooth|airplane|location|display|sound"}, volume{"dir":"up|down|max|mute"}, camera{}. ' +
  'Otherwise just answer the question.';

async function complete(messages: any[], maxTokens: number): Promise<string> {
  const ctx: any = (modelStore as any).context;
  if (!ctx) {
    throw new Error('model not loaded');
  }
  const res = await ctx.completion(
    {
      messages,
      n_predict: maxTokens,
      temperature: 0.4,
      top_p: 0.9,
      stop: ['<|im_end|>', '<|eot_id|>', '</s>', '<end_of_turn>'],
    },
    () => {},
  );
  const raw =
    res?.text ?? res?.content ?? res?.choices?.[0]?.message?.content ?? res?.reasoning_content ?? '';
  return String(raw)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

async function personaText(): Promise<string> {
  if (!S.personaId || S.personaId === 'default') {
    return '';
  }
  try {
    await Promise.race([(palStore as any).ready, sleep(4000)]);
  } catch (_e) {
    // use what is loaded
  }
  const pal: any = ((palStore as any).pals ?? []).find((p: any) => p.id === S.personaId);
  if (!pal) {
    return '';
  }
  const params = pal.parameters ?? {};
  return String(pal.systemPrompt ?? '')
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m: string, k: string) => String(params[k] ?? ''))
    .replace(/\{(\w+)\}/g, (m: string, k: string) => (params[k] !== undefined ? String(params[k]) : m))
    .trim()
    .slice(0, 700);
}

const askLlm = (history: Msg[], text: string) =>
  complete(
    [
      {role: 'system', content: (PERSONA ? 'Your personality and role: ' + PERSONA + '\n\n' : '') + SYSTEM},
      ...history.slice(S.conversation === 'continuous' ? -12 : -6),
      {role: 'user', content: text},
    ],
    160,
  );

async function writeEmail(to: string, topic: string): Promise<{subject: string; body: string}> {
  const prompt =
    'Write a short, polite, clear email' + (to ? ' to ' + to : '') + '. What it should say: ' + topic + '.\n' +
    'Reply in exactly this format and nothing else:\nSUBJECT: <subject line>\nBODY:\n<the email text with a greeting and a sign-off>';
  const out = await complete([{role: 'user', content: prompt}], 320);
  const m = out.match(/SUBJECT:\s*(.+)\s*\n+\s*BODY:\s*([\s\S]+)/i);
  if (m) {
    return {subject: m[1].trim(), body: m[2].trim()};
  }
  return {subject: topic.slice(0, 60), body: out};
}

const spokenClean = (s: string) =>
  s
    .replace(/[*#_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);

async function summarise(kind: 'screen' | 'notifications', text: string): Promise<string> {
  await unloadWhisper();
  const ok = await ensureModel();
  if (!ok) {
    return 'I could not load a model to summarise that.';
  }
  const what = kind === 'screen' ? 'screen text' : 'phone notifications';
  const prompt =
    'Summarise these ' + what + ' in three short spoken sentences. Be concrete: who or what app, and the key point. Skip spam and ads.\n\n' +
    text.slice(0, kind === 'screen' ? 3000 : 2400);
  let out = '';
  try {
    out = await complete([{role: 'user', content: prompt}], 150);
  } finally {
    if (unloadEach()) {
      await offloadModel();
    }
  }
  return out || 'I could not summarise that.';
}

const FIRST_LINES = (txt: string, n: number) =>
  txt
    .trim()
    .split('\n')
    .filter(l => l.trim())
    .slice(0, n)
    .join('. ');

async function readScreenText(): Promise<string> {
  const txt = String((await N.getScreenText()) ?? '').trim();
  if (!txt) {
    return 'I could not see any text on the screen. In the default assistant settings, turn on use text from screen.';
  }
  if (txt.length < 350) {
    return txt.replace(/\n+/g, '. ');
  }
  return summarise('screen', txt);
}

// A model that can see pictures. Uses the one chosen in settings, else the first downloaded one that can see.
async function ensureVisionModel(): Promise<boolean> {
  const ms: any = modelStore;
  for (let i = 0; i < 200 && ms.isContextLoading; i++) {
    await sleep(150);
  }
  if (ms.context) {
    try {
      if (await ms.context.isMultimodalEnabled?.()) {
        return true;
      }
    } catch (_e) {
      // not a vision model
    }
    if (baselineCtx) {
      return false; // the app's own model is loaded and cannot see: leave it alone
    }
    await offloadModel();
  }
  for (let i = 0; i < 40 && !(ms.models && ms.models.length > 0); i++) {
    await sleep(150);
  }
  const canSee = (m: any) => !!(m && (m.supportsMultimodal || m.defaultProjectionModel || m.visionEnabled));
  const cands: any[] = (ms.models ?? []).filter((m: any) => m.isDownloaded && canSee(m));
  const chosen = S.visionModelId !== 'auto' ? cands.find(m => m.id === S.visionModelId) : undefined;
  const model = chosen ?? cands[0];
  if (!model) {
    return false;
  }
  try {
    await ms.initContext(model);
  } finally {
    if (sessionOver) {
      await offloadModel();
    }
  }
  try {
    return !!(await ms.context?.isMultimodalEnabled?.());
  } catch (_e) {
    return !!ms.context;
  }
}

// Takes the screenshot Android gave the assistant, asks the vision model about it, then deletes the picture.
async function visionAnswer(question: string): Promise<string> {
  let path = '';
  try {
    path = await N.getScreenshotScaled(900);
    if (!path) {
      return '@NOVISION';
    }
    await unloadWhisper();
    if (!(await ensureVisionModel())) {
      return '@NOVISION';
    }
    const ctx: any = (modelStore as any).context;
    const res = await ctx.completion(
      {
        messages: [
          {
            role: 'user',
            content: [
              {type: 'text', text: 'This is a screenshot of my phone. ' + question + ' Answer in two or three short spoken sentences.'},
              {type: 'image_url', image_url: {url: 'file://' + path}},
            ],
          },
        ],
        n_predict: 200,
        temperature: 0.3,
        stop: ['<|im_end|>', '<|eot_id|>', '</s>', '<end_of_turn>'],
      },
      () => {},
    );
    const raw = res?.text ?? res?.content ?? '';
    return String(raw).replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '@NOVISION';
  } catch (_e) {
    return '@NOVISION';
  } finally {
    try {
      await N.deleteTempShots();
    } catch (_x) {
      // ignore
    }
    if (unloadEach()) {
      await offloadModel();
    }
  }
}

// ---------------------------------------------------------------- liquid glass
// A native lens that bends and softly blurs the app behind it. If it is missing, plain tinted glass is used.
let GlassNative: any = null;
try {
  const um: any = UIManager;
  if (!um.hasViewManagerConfig || um.hasViewManagerConfig('PocketGlass')) {
    GlassNative = requireNativeComponent('PocketGlass');
  }
} catch (_e) {
  GlassNative = null;
}

class GlassBoundary extends React.Component<{children?: React.ReactNode}, {bad: boolean}> {
  state = {bad: false};
  static getDerivedStateFromError() {
    return {bad: true};
  }
  render() {
    return this.state.bad ? null : this.props.children;
  }
}

const hexToRgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
};

let InkNative: any = null;
try {
  const um2: any = UIManager;
  if (!um2.hasViewManagerConfig || um2.hasViewManagerConfig('PocketInk')) {
    InkNative = requireNativeComponent('PocketInk');
  }
} catch (_e) {
  InkNative = null;
}

// Glass orbs: lenses that bend the app behind them, drifting and pulsing like a liquid.
const ORBS = [
  {size: 92, x: -34, y: 8, tint: 'rgba(130,90,255,0.26)', dx: 8, dy: 6, dur: 2600},
  {size: 100, x: 30, y: 0, tint: 'rgba(70,140,255,0.24)', dx: -9, dy: 7, dur: 3100},
  {size: 78, x: -2, y: -28, tint: 'rgba(255,120,200,0.24)', dx: 7, dy: -8, dur: 2300},
  {size: 58, x: -12, y: 36, tint: 'rgba(90,230,235,0.22)', dx: -6, dy: -5, dur: 2900},
  {size: 52, x: 50, y: 38, tint: 'rgba(255,190,110,0.22)', dx: 5, dy: 6, dur: 3300},
];

const GlassOrbs: React.FC<{amp: Animated.Value; spin: Animated.Value; strength: number}> = ({amp, spin, strength}) => {
  const drifts = useRef(ORBS.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const anims = drifts.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {toValue: 1, duration: ORBS[i].dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
          Animated.timing(v, {toValue: 0, duration: ORBS[i].dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
        ]),
      ),
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [drifts]);
  return (
    <Animated.View
      style={{width: 200, height: 150, transform: [{rotate: spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})}]}}>
      {ORBS.map((o, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: o.size,
            height: o.size,
            left: 100 + o.x - o.size / 2,
            top: 75 + o.y - o.size / 2,
            transform: [
              {translateX: drifts[i].interpolate({inputRange: [0, 1], outputRange: [-o.dx, o.dx]})},
              {translateY: drifts[i].interpolate({inputRange: [0, 1], outputRange: [-o.dy, o.dy]})},
              {scale: amp.interpolate({inputRange: [0, 1], outputRange: [0.9, 1.16 + i * 0.03]})},
            ],
          }}>
          <GlassBoundary>
            <GlassNative style={StyleSheet.absoluteFill} tint={o.tint} radius={o.size / 2} strength={strength} tracking />
          </GlassBoundary>
        </Animated.View>
      ))}
    </Animated.View>
  );
};

// ---------------------------------------------------------------- circle to search
const SCREEN = Dimensions.get('screen');
type Box = {x: number; y: number; w: number; h: number};

const CircleLayer: React.FC<{uri: string; target: string; onResult: (box: Box | null, target: string) => void}> = ({uri, target, onResult}) => {
  const [pts, setPts] = useState<Array<{x: number; y: number}>>([]);
  const [box, setBox] = useState<Box | null>(null);
  const ref = useRef<Array<{x: number; y: number}>>([]);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: e => {
        ref.current = [{x: e.nativeEvent.pageX, y: e.nativeEvent.pageY}];
        setPts([...ref.current]);
        setBox(null);
      },
      onPanResponderMove: e => {
        const p = {x: e.nativeEvent.pageX, y: e.nativeEvent.pageY};
        const last = ref.current[ref.current.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 10) {
          ref.current.push(p);
          setPts([...ref.current]);
        }
      },
      onPanResponderRelease: () => {
        const a = ref.current;
        if (a.length < 4) {
          return;
        }
        const xs = a.map(p => p.x);
        const ys = a.map(p => p.y);
        const pad = 28;
        const x = Math.max(0, Math.min(...xs) - pad);
        const y = Math.max(0, Math.min(...ys) - pad);
        const b: Box = {
          x,
          y,
          w: Math.min(SCREEN.width - x, Math.max(...xs) - x + pad),
          h: Math.min(SCREEN.height - y, Math.max(...ys) - y + pad),
        };
        setBox(b);
        if (target !== 'ask') {
          onResult(b, target);
        }
      },
    }),
  ).current;
  return (
    <View style={styles.circleRoot} {...pan.panHandlers}>
      <Image source={{uri}} style={{position: 'absolute', width: SCREEN.width, height: SCREEN.height}} resizeMode="stretch" />
      <View pointerEvents="none" style={styles.circleDim} />
      {pts.map((p, i) => (
        <View key={i} pointerEvents="none" style={[styles.circleDot, {left: p.x - 6, top: p.y - 6}]} />
      ))}
      {box && (
        <View pointerEvents="none" style={[styles.circleBox, {left: box.x, top: box.y, width: box.w, height: box.h}]} />
      )}
      <View style={styles.circleBar}>
        {!box && <Text style={styles.circleHint}>Draw a circle around what you want to search</Text>}
        {box && target === 'ask' && (
          <View style={styles.circleBtns}>
            <Pressable style={styles.circleBtn} onPress={() => onResult(box, 'lens')}>
              <Text style={styles.circleBtnText}>Google Lens</Text>
            </Pressable>
            <Pressable style={styles.circleBtn} onPress={() => onResult(box, 'chooser')}>
              <Text style={styles.circleBtnText}>Choose app</Text>
            </Pressable>
            <Pressable style={styles.circleBtn} onPress={() => onResult(box, 'save')}>
              <Text style={styles.circleBtnText}>Save</Text>
            </Pressable>
          </View>
        )}
        <Pressable style={styles.circleCancel} onPress={() => onResult(null, 'cancel')}>
          <Text style={styles.circleBtnText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
};

// ---------------------------------------------------------------- the living cloud
const BLOBS = [
  {size: 58, x: -30, y: 8, color: 'rgba(124,92,255,0.50)', dx: 7, dy: 5, dur: 2600},
  {size: 66, x: 26, y: 5, color: 'rgba(79,140,255,0.50)', dx: -8, dy: 6, dur: 3100},
  {size: 76, x: 0, y: -10, color: 'rgba(176,124,255,0.46)', dx: 6, dy: -7, dur: 2300},
  {size: 46, x: -4, y: 24, color: 'rgba(92,225,230,0.46)', dx: -6, dy: -5, dur: 2900},
  {size: 42, x: 38, y: 26, color: 'rgba(255,122,198,0.42)', dx: 5, dy: 6, dur: 3300},
];

const loopValue = (v: Animated.Value, dur: number) =>
  Animated.loop(
    Animated.sequence([
      Animated.timing(v, {toValue: 1, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
      Animated.timing(v, {toValue: 0, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
    ]),
  );

const SHADE_STEPS = 18;
const BottomShade: React.FC = () => (
  <View pointerEvents="none" style={styles.shade}>
    {Array.from({length: SHADE_STEPS}).map((_, i) => (
      <View
        key={i}
        style={{flex: 1, backgroundColor: 'rgba(0,0,0,' + (0.62 * Math.pow((i + 1) / SHADE_STEPS, 1.7)).toFixed(3) + ')'}}
      />
    ))}
  </View>
);

const GLOWS = [
  {h: 30, c: 'rgba(80,120,255,0.20)'},
  {h: 56, c: 'rgba(150,100,255,0.14)'},
  {h: 86, c: 'rgba(255,110,190,0.10)'},
  {h: 120, c: 'rgba(92,225,230,0.07)'},
];
const BottomGlow: React.FC<{amp: Animated.Value}> = ({amp}) => (
  <Animated.View
    pointerEvents="none"
    style={[
      styles.glowWrap,
      {
        opacity: amp.interpolate({inputRange: [0, 1], outputRange: [0.5, 1]}),
        transform: [{scaleY: amp.interpolate({inputRange: [0, 1], outputRange: [0.9, 1.25]})}],
      },
    ]}>
    {GLOWS.map((g, i) => (
      <View
        key={i}
        style={{position: 'absolute', bottom: -g.h / 2, left: -80, right: -80, height: g.h, borderRadius: g.h, backgroundColor: g.c}}
      />
    ))}
  </Animated.View>
);

const Cloud: React.FC<{amp: Animated.Value; spin: Animated.Value}> = ({amp, spin}) => {
  const drifts = useRef(BLOBS.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const anims = drifts.map((v, i) => loopValue(v, BLOBS[i].dur));
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [drifts]);
  return (
    <Animated.View
      style={[
        styles.cloud,
        {transform: [{rotate: spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']})}]},
      ]}>
      <Animated.View
        style={[
          styles.halo,
          {
            transform: [{scale: amp.interpolate({inputRange: [0, 1], outputRange: [0.8, 1.35]})}],
            opacity: amp.interpolate({inputRange: [0, 1], outputRange: [0.25, 0.6]}),
          },
        ]}
      />
      {BLOBS.map((b, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: b.size,
            height: b.size,
            borderRadius: b.size / 2,
            backgroundColor: b.color,
            left: 70 + b.x - b.size / 2,
            top: 55 + b.y - b.size / 2,
            transform: [
              {translateX: drifts[i].interpolate({inputRange: [0, 1], outputRange: [-b.dx, b.dx]})},
              {translateY: drifts[i].interpolate({inputRange: [0, 1], outputRange: [-b.dy, b.dy]})},
              {scale: amp.interpolate({inputRange: [0, 1], outputRange: [0.86, 1.18 + i * 0.04]})},
            ],
          }}
        />
      ))}
    </Animated.View>
  );
};

export default function AssistRoot() {
  const [phase, setPhase] = useState<Phase>('starting');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [hidden, setHidden] = useState(false);
  const [cropPath, setCropPath] = useState('');
  const [shade, setShade] = useState(true);
  const [glow, setGlow] = useState(true);
  const [size, setSize] = useState(1);
  const [glass, setGlass] = useState(true);
  const [tint, setTint] = useState('rgba(124,92,255,0.22)');
  const amp = useRef(new Animated.Value(0.15)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const alive = useRef(true);
  const closing = useRef(false);
  const acting = useRef(false);
  const phaseRef = useRef<Phase>('starting');
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    beginSession();
  }
  const loop = useRef<Animated.CompositeAnimation | null>(null);
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);

  const setPh = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const releaseAll = async () => {
    sessionOver = true;
    await Promise.all([guard(unloadWhisper(), 6000), guard(offloadModel(), 30000), guard(unloadVoice(), 6000)]);
  };

  const finish = async () => {
    if (closing.current) {
      return;
    }
    closing.current = true;
    alive.current = false;
    setHidden(true);
    try {
      N?.stopListening();
      N?.stopSpeaking();
    } catch (_e) {
      // ignore
    }
    try {
      await guard(Promise.resolve((ttsStore as any).stop?.('assistant')), 2000);
    } catch (_e) {
      // ignore
    }
    await releaseAll();
    assistActive = false;
    try {
      N?.deleteTempShots();
    } catch (_e) {
      // ignore
    }
    N?.close();
  };

  // bars of the cloud: real voice level while listening, calm waves otherwise
  useEffect(() => {
    loop.current?.stop();
    spinLoop.current?.stop();
    if (phase !== 'listening') {
      const lo = phase === 'speaking' ? 0.3 : phase === 'thinking' ? 0.2 : 0.1;
      const hi = phase === 'speaking' ? 0.95 : phase === 'thinking' ? 0.7 : 0.4;
      const dur = phase === 'speaking' ? 320 : phase === 'thinking' ? 520 : 1100;
      loop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(amp, {toValue: hi, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
          Animated.timing(amp, {toValue: lo, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
        ]),
      );
      loop.current.start();
    }
    if (phase === 'thinking') {
      spin.setValue(0);
      spinLoop.current = Animated.loop(
        Animated.timing(spin, {toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: true}),
      );
      spinLoop.current.start();
    } else {
      spin.setValue(0);
    }
    return () => {
      loop.current?.stop();
      spinLoop.current?.stop();
    };
  }, [phase, amp, spin]);

  useEffect(() => {
    if (!N) {
      return;
    }
    const emitter = new NativeEventEmitter(N);
    const inkSub = emitter.addListener('AssistInk', (e: any) => {
      onInk(e);
    });
    const sub = emitter.addListener('AssistLevel', (v: number) => {
      if (phaseRef.current === 'listening') {
        Animated.timing(amp, {
          toValue: Math.max(0.12, Math.min(1, v * 1.7)),
          duration: 90,
          useNativeDriver: true,
        }).start();
      }
    });
    return () => {
      sub.remove();
      inkSub.remove();
    };
  }, [amp]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      finish();
      return true;
    });
    // leaving the panel in any other way (home, recents, another app) also unloads everything
    const app = AppState.addEventListener('change', s => {
      if (s !== 'active' && !acting.current) {
        finish();
      }
    });
    return () => {
      back.remove();
      app.remove();
    };
  }, []);

  useEffect(() => {
    alive.current = true;
    run();
    return () => {
      alive.current = false;
      try {
        N?.stopListening();
        N?.stopSpeaking();
      } catch (_e) {
        // ignore
      }
      releaseAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const say = async (text: any) => {
    let s = spokenClean(String(text ?? ''));
    if (!s || s === 'undefined' || s === 'null') {
      s = 'Sorry, something went wrong with that.';
    }
    setReply(s);
    setPh('speaking');
    const ok = await speakApp(s);
    if (!ok) {
      await Promise.race([N.speak(s), sleep(40000)]);
    }
  };

  const doTarget = async (path: string, target: string) => {
    acting.current = true;
    if (target === 'save') {
      await N.saveImage(path);
    } else if (target === 'lens') {
      await N.shareImage(path, 'com.google.android.googlequicksearchbox');
    } else {
      await N.shareImage(path, S.circlePackage || '');
    }
    setCropPath('');
    await finish();
  };

  // you drew on the screen: a short tap closes, a circle searches what is inside it
  const onInk = async (e: any) => {
    if (closing.current) {
      return;
    }
    if ((e?.moved ?? 0) < 45) {
      finish();
      return;
    }
    const path: string = await N.cropShot(e.fx, e.fy, e.fw, e.fh);
    if (!path) {
      setReply('To search what you circle, turn on "use screenshot" in the default assistant settings.');
      return;
    }
    if (S.circleTarget === 'ask') {
      setCropPath(path);
      return;
    }
    await doTarget(path, S.circleTarget);
  };

  async function run() {
    try {
      if (!N) {
        setReply('Assistant module is missing in this build.');
        return;
      }
      setPh('starting');
      try {
        N.cleanupOld(120000);
      } catch (_e) {
        // ignore
      }
      S = await loadSettings();
      PERSONA = await personaText();
      setShade(S.showShade);
      setGlow(S.showGlow);
      setSize(S.cloudSize);
      setGlass(S.glass);
      if (S.glassTint === 'system') {
        try {
          const hex: string = await N.getAccent();
          if (hex) {
            setTint(hexToRgba(hex, 0.24));
          }
        } catch (_e) {
          // keep the PocketPal colours
        }
      }
      try {
        await (asrStore as any).init();
      } catch (_e) {
        // already initialised
      }
      try {
        await (ttsStore as any).init();
      } catch (_e) {
        // already initialised
      }
      if (!asrStore.isSelectedTierReady) {
        await say('Open PocketPal once and finish the voice setup first.');
        await finish();
        return;
      }
      const tier = asrStore.selectedTier;
      const history: Msg[] = [];
      let first = true;
      let pendingEmail: {to: string} | null = null;

      while (alive.current) {
        setPh('listening');
        setHeard('');
        const warm = loadWhisper(tier).catch(() => {}); // loads while you speak
        const pcm: string = await N.listen(14000, S.silenceMs, first ? 8000 : S.conversation === 'continuous' ? S.idleSeconds * 1000 : 6000);
        if (!alive.current) {
          return;
        }
        if (!pcm) {
          await finish();
          return;
        }
        first = false;
        setPh('thinking');
        await warm;
        const tr: any = await whisperAsrEngine.transcribe(pcm, {
          tier,
          language: asrStore.spokenLanguage ?? undefined,
        });
        const text = String(tr?.text ?? '').trim();
        if (!alive.current) {
          return;
        }
        if (!text) {
          continue;
        }
        setHeard(text);

        const hit = pendingEmail ? null : matchSkill(text);
        let act: any = pendingEmail ? {a: 'email', to: pendingEmail.to, topic: text} : hit ? skillAct(hit, text) : ruleIntent(text);
        if (!hit && act && !S.phoneActions && act.a && !['close', 'unload', 'notes_read'].includes(act.a)) {
          act = null;
        }
        pendingEmail = null;
        let spoken = '';
        if (act?.a === 'close') {
          await finish();
          return;
        }
        if (act && ['screen', 'vision', 'notifs', 'note_add', 'notes_read', 'notes_clear', 'unload', 'skill_ai', 'screenshot', 'circle'].includes(act.a)) {
          const sp = act;
          act = null;
          setPh('thinking');
          if (sp.a === 'unload') {
            spoken = 'Okay, everything is unloaded.';
            await releaseAll();
            await say(spoken);
            await finish();
            return;
          }
          if (sp.a === 'screenshot') {
            acting.current = true;
            await releaseAll();
            await N.takeScreenshotNow();
            await finish();
            return;
          }
          if (sp.a === 'circle') {
            await say('Draw a circle with your finger around what you want to search.');
            continue;
          }
          if (sp.a === 'skill_ai') {
            await unloadWhisper();
            const okm = await ensureModel();
            if (!okm) {
              spoken = 'I could not load a model.';
            } else {
              try {
                spoken = await complete(
                  [{role: 'system', content: sp.instruction}, {role: 'user', content: sp.input}],
                  160,
                );
              } finally {
                if (unloadEach()) {
                  await offloadModel();
                }
              }
              spoken = spoken || 'Sorry, I did not get that.';
            }
          } else if (sp.a === 'note_add') {
            if (!sp.text) {
              spoken = 'What should I write in the note?';
            } else {
              await N.addNote(sp.text);
              spoken = 'Saved to your notes.';
            }
          } else if (sp.a === 'notes_clear') {
            await N.clearNotes();
            spoken = 'Your notes are cleared.';
          } else if (sp.a === 'notes_read') {
            const nt = String((await N.getNotes()) ?? '').trim();
            spoken = nt ? 'Your latest notes. ' + nt.split('\n').filter((l: string) => l.trim()).slice(-6).join('. ') : 'You have no notes.';
          } else if (sp.a === 'screen') {
            spoken = await readScreenText();
          } else if (sp.a === 'vision') {
            const v = S.screenVision ? await visionAnswer(text) : '@NOVISION';
            spoken =
              v && v !== '@NOVISION'
                ? v
                : (S.screenVision ? 'I could not use a vision model, so I read the text on the screen instead. ' : '') + (await readScreenText());
          } else if (sp.a === 'notifs') {
            const txt = String((await N.getNotifications()) ?? '').trim();
            if (txt === 'NOACCESS') {
              acting.current = true;
              await releaseAll();
              await N.perform('settings', JSON.stringify({page: 'notification_access'}));
              await finish();
              return;
            }
            if (!txt) {
              spoken = 'You have no notifications.';
            } else if (txt.split('\n').filter((l: string) => l.trim()).length <= 3) {
              spoken = FIRST_LINES(txt, 3);
            } else {
              spoken = await summarise('notifications', txt);
            }
          }
          history.push({role: 'user', content: text}, {role: 'assistant', content: spoken});
          await say(spoken);
          continue;
        }
        if (act?.say) {
          spoken = act.say;
          act = null;
        } else if (act?.a === 'email' && !act.topic) {
          pendingEmail = {to: act.to};
          spoken = 'What should the email say?';
          act = null;
        } else if (!act) {
          // needs the model: free the speech model first, load the model, answer, unload it at once
          await unloadWhisper();
          setPh('thinking');
          const ok = await ensureModel();
          if (!ok) {
            spoken = 'I could not load a model. Open PocketPal and pick one.';
          } else {
            const out = await askLlm(history, text);
            const m = out.match(/ACTION\s*(\{[\s\S]*\})/);
            if (m) {
              try {
                act = JSON.parse(m[1]);
              } catch (_e) {
                act = null;
              }
            }
            if (!act || !act.a) {
              act = null;
              spoken = out.replace(/ACTION[\s\S]*/g, '').trim() || 'Sorry, I did not get that.';
            }
          }
          if (!(act && act.a === 'email') && unloadEach()) {
            await offloadModel();
          }
        }
        if (act && act.a === 'email') {
          if (!act.topic) {
            pendingEmail = {to: act.to ?? ''};
            await offloadModel();
            await say('What should the email say?');
            continue;
          }
          await unloadWhisper();
          setPh('thinking');
          const ok = await ensureModel();
          if (!ok) {
            await offloadModel();
            await say('I could not load a model to write the email.');
            await finish();
            return;
          }
          const mail = await writeEmail(act.to ?? '', act.topic);
          if (unloadEach()) {
            await offloadModel();
          }
          act = {a: 'email', to: act.to ?? '', subject: mail.subject, body: mail.body};
        }
        if (act) {
          setPh('thinking');
          const launching = LAUNCHING.includes(act.a);
          if (act.a === 'callhelper') {
            acting.current = true;
          }
          if (launching) {
            acting.current = true;
            await releaseAll(); // everything is unloaded before another app takes the screen
          }
          const res: string = await N.perform(act.a, JSON.stringify(act));
          const kind = res.slice(0, res.indexOf(':'));
          const msg = res.slice(res.indexOf(':') + 1);
          if (kind === 'OK') {
            await finish();
            return;
          }
          acting.current = false;
          await say(msg);
          if (act.a === 'battery') {
            continue;
          }
          await finish();
          return;
        }
        history.push({role: 'user', content: text}, {role: 'assistant', content: spoken});
        await say(spoken);
        if (S.conversation === 'one') {
          await finish();
          return;
        }
      }
    } catch (e: any) {
      setReply('Something went wrong: ' + String(e?.message ?? e).slice(0, 140));
      setPh('speaking');
      await sleep(4000);
      await finish();
    }
  }

  const hint =
    phase === 'starting' ? 'Getting ready...' : phase === 'listening' ? 'Listening...' : phase === 'thinking' ? 'Thinking...' : '';
  const line = heard || hint;

  if (hidden) {
    return <View style={styles.root} />;
  }
  return (
    <View style={styles.root}>
      {InkNative ? <InkNative style={StyleSheet.absoluteFill} /> : <Pressable style={StyleSheet.absoluteFill} onPress={finish} />}
      {shade && <BottomShade />}
      {glow && <BottomGlow amp={amp} />}
      <View style={styles.bottom} pointerEvents="box-none">
        {!!cropPath && (
          <View style={styles.askRow}>
            <Pressable style={styles.askBtn} onPress={() => doTarget(cropPath, 'lens')}>
              <Text style={styles.askText}>Google Lens</Text>
            </Pressable>
            <Pressable style={styles.askBtn} onPress={() => doTarget(cropPath, 'chooser')}>
              <Text style={styles.askText}>Choose app</Text>
            </Pressable>
            <Pressable style={styles.askBtn} onPress={() => doTarget(cropPath, 'save')}>
              <Text style={styles.askText}>Save</Text>
            </Pressable>
          </View>
        )}
        {(!!line || !!reply) && (
          <View style={[styles.pill, glass && styles.pillGlass]} pointerEvents="none">
            {glass && GlassNative && (
              <GlassBoundary>
                <GlassNative style={StyleSheet.absoluteFill} tint={tint} radius={22} strength={S.glassRefract} />
              </GlassBoundary>
            )}
            {!!line && (
              <Text style={styles.heard} numberOfLines={2}>
                {line}
              </Text>
            )}
            {!!reply && (
              <Text style={styles.reply} numberOfLines={5}>
                {reply}
              </Text>
            )}
          </View>
        )}
        <Pressable
          onPress={() => {
            if (phaseRef.current === 'speaking') {
              N?.stopSpeaking();
              (ttsStore as any).stop?.('assistant');
            }
          }}>
          <View style={{transform: [{scale: size}]}}>
            {glass && GlassNative ? (
              <GlassOrbs amp={amp} spin={spin} strength={S.glassRefract + 4} />
            ) : (
              <Cloud amp={amp} spin={spin} />
            )}
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'transparent'},
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingBottom: 36,
  },
  pill: {
    backgroundColor: 'rgba(12,12,20,0.55)',
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginBottom: 6,
    maxWidth: '88%',
    overflow: 'hidden',
  },
  bubble: {width: 160, height: 160, borderRadius: 80, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  pillGlass: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  askRow: {flexDirection: 'row', gap: 10, marginBottom: 10},
  askBtn: {paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)'},
  askText: {color: '#FFFFFF', fontSize: 14, fontWeight: '600'},
  heard: {color: '#FFFFFF', fontSize: 16, fontWeight: '600', textAlign: 'center'},
  reply: {color: '#D8DAE0', fontSize: 14, marginTop: 6, textAlign: 'center', lineHeight: 20},
  circleRoot: {flex: 1, backgroundColor: '#000'},
  circleDim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.28)'},
  circleDot: {position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: '#7C5CFF'},
  circleBox: {position: 'absolute', borderWidth: 3, borderColor: '#7C5CFF', borderRadius: 14},
  circleBar: {position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingBottom: 48, paddingTop: 16, backgroundColor: 'rgba(0,0,0,0.55)'},
  circleHint: {color: '#FFFFFF', fontSize: 16, marginBottom: 10},
  circleBtns: {flexDirection: 'row', gap: 10, marginBottom: 10},
  circleBtn: {paddingHorizontal: 18, paddingVertical: 11, borderRadius: 20, backgroundColor: '#7C5CFF'},
  circleCancel: {paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)'},
  circleBtnText: {color: '#FFFFFF', fontSize: 15, fontWeight: '600'},
  shade: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 190, flexDirection: 'column'},
  glowWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 60},
  cloud: {width: 140, height: 110},
  halo: {
    position: 'absolute',
    left: 15,
    top: 0,
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(124,92,255,0.35)',
  },
});

// Used by the background AI conversations (texts and calls).
DeviceEventEmitter.addListener('AssistClosed', () => {
  sessionOver = true;
  Promise.all([guard(unloadWhisper(), 6000), guard(offloadModel(), 30000), guard(unloadVoice(), 6000)]).then(() => {
    try {
      N?.deleteTempShots();
    } catch (_e) {
      // ignore
    }
  });
});

export function setS(v: AssistSettingsT) {
  S = v;
}
export {beginSession, complete, ensureModel, loadWhisper, offloadModel, unloadWhisper};
