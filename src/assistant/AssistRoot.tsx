import React, {useEffect, useRef, useState} from 'react';
import {
  Animated,
  BackHandler,
  NativeEventEmitter,
  NativeModules,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {asrStore, modelStore} from '../store';
import {whisperAsrEngine} from '../services/asr';

// PocketPal assistant: a floating voice panel (like Google Assistant) that listens,
// understands what you want, runs phone actions, or answers with the on-device model.

const N: any = (NativeModules as any).AssistNative;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Phase = 'starting' | 'listening' | 'thinking' | 'speaking';
type Act = {a: string; [k: string]: any};
type Msg = {role: 'user' | 'assistant'; content: string};

// ---------------------------------------------------------------- model load / offload
let loadedByAssistant = false;

async function ensureModel(): Promise<boolean> {
  const ms: any = modelStore;
  for (let i = 0; i < 60 && ms.isContextLoading; i++) {
    await sleep(150);
  }
  if (ms.context) {
    return true;
  }
  for (let i = 0; i < 40 && !(ms.models && ms.models.length > 0); i++) {
    await sleep(150);
  }
  const id = ms.lastUsedModelId ?? ms.activeModelId ?? ms.lastAutoReleasedModelId;
  const list: any[] = ms.models ?? [];
  const model = list.find(m => m.id === id) ?? list.find(m => m.isDownloaded);
  if (!model) {
    return false;
  }
  loadedByAssistant = true;
  await ms.initContext(model);
  return !!ms.context;
}

async function offloadModel() {
  if (loadedByAssistant) {
    loadedByAssistant = false;
    try {
      await (modelStore as any).releaseContext();
    } catch (_e) {
      // ignore
    }
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
  'flashlight{"on":true|false}, search{"q"}, music{"q"}, settings{"page":"wifi|bluetooth|airplane|location|display|sound"}, ' +
  'volume{"dir":"up|down|max|mute"}, camera{}. Otherwise just answer the question.';

async function askLlm(history: Msg[], text: string): Promise<string> {
  const ctx: any = (modelStore as any).context;
  if (!ctx) {
    throw new Error('model not loaded');
  }
  const res = await ctx.completion(
    {
      messages: [{role: 'system', content: SYSTEM}, ...history.slice(-6), {role: 'user', content: text}],
      n_predict: 160,
      temperature: 0.3,
      top_p: 0.9,
      stop: ['<|im_end|>', '<|eot_id|>', '</s>', '<end_of_turn>'],
    },
    () => {},
  );
  return String(res?.text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

const spokenClean = (s: string) =>
  s
    .replace(/[*#_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);

// ---------------------------------------------------------------- the look
const COLORS = ['#4285F4', '#EA4335', '#FBBC04', '#34A853', '#4285F4'];
const MAXH = [26, 44, 62, 44, 26];

const Bars: React.FC<{amp: Animated.Value}> = ({amp}) => (
  <View style={styles.bars}>
    {COLORS.map((c, i) => (
      <Animated.View
        key={i}
        style={[
          styles.bar,
          {
            backgroundColor: c,
            height: amp.interpolate({inputRange: [0, 1], outputRange: [10, MAXH[i]]}),
          },
        ]}
      />
    ))}
  </View>
);

export default function AssistRoot() {
  const [phase, setPhase] = useState<Phase>('starting');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const amp = useRef(new Animated.Value(0.1)).current;
  const alive = useRef(true);
  const closing = useRef(false);
  const loop = useRef<Animated.CompositeAnimation | null>(null);

  const finish = async () => {
    if (closing.current) {
      return;
    }
    closing.current = true;
    alive.current = false;
    try {
      N?.stopListening();
      N?.stopSpeaking();
    } catch (_e) {
      // ignore
    }
    try {
      await whisperAsrEngine.release();
    } catch (_e) {
      // ignore
    }
    await offloadModel();
    N?.close();
  };

  // animate the bars: real mic level while listening, a gentle wave otherwise
  useEffect(() => {
    loop.current?.stop();
    if (phase === 'thinking' || phase === 'speaking' || phase === 'starting') {
      const lo = phase === 'speaking' ? 0.25 : 0.12;
      const hi = phase === 'speaking' ? 0.9 : 0.5;
      loop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(amp, {toValue: hi, duration: 420, useNativeDriver: false}),
          Animated.timing(amp, {toValue: lo, duration: 420, useNativeDriver: false}),
        ]),
      );
      loop.current.start();
    }
    return () => loop.current?.stop();
  }, [phase, amp]);

  useEffect(() => {
    if (!N) {
      return;
    }
    const emitter = new NativeEventEmitter(N);
    const sub = emitter.addListener('AssistLevel', (v: number) => {
      if (phase === 'listening') {
        Animated.timing(amp, {toValue: Math.max(0.1, Math.min(1, v * 1.6)), duration: 70, useNativeDriver: false}).start();
      }
    });
    return () => sub.remove();
  }, [phase, amp]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      finish();
      return true;
    });
    return () => back.remove();
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const say = async (text: string) => {
    const s = spokenClean(text);
    setReply(s);
    setPhase('speaking');
    await N.speak(s);
  };

  async function run() {
    try {
      if (!N) {
        setReply('Assistant module is missing in this build.');
        return;
      }
      setPhase('starting');
      try {
        await (asrStore as any).init();
      } catch (_e) {
        // already initialised
      }
      if (!asrStore.isSelectedTierReady) {
        await say('Open PocketPal once and finish the voice setup first.');
        await finish();
        return;
      }
      const tier = asrStore.selectedTier;
      const whisperReady = whisperAsrEngine.preload(tier).catch(() => {});
      const modelReady = ensureModel().catch(() => false);
      const history: Msg[] = [];
      let first = true;

      while (alive.current) {
        setPhase('listening');
        setHeard('');
        const pcm: string = await N.listen(14000, 900, first ? 8000 : 6000);
        if (!alive.current) {
          return;
        }
        if (!pcm) {
          await finish();
          return;
        }
        first = false;
        setPhase('thinking');
        await whisperReady;
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
        let act: any = ruleIntent(text);
        let spoken = '';
        if (act?.a === 'close') {
          await finish();
          return;
        }
        if (act?.say) {
          spoken = act.say;
          act = null;
        } else if (!act) {
          const ok = await modelReady;
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
        }
        if (act) {
          setPhase('thinking');
          const msg: string = await N.perform(act.a, JSON.stringify(act));
          await say(msg);
          if (act.a === 'battery') {
            continue;
          }
          await finish();
          return;
        }
        history.push({role: 'user', content: text}, {role: 'assistant', content: spoken});
        await say(spoken);
      }
    } catch (e: any) {
      setReply('Something went wrong: ' + String(e?.message ?? e).slice(0, 160));
      setPhase('speaking');
      await sleep(5000);
      await finish();
    }
  }

  const hint =
    phase === 'starting' ? 'Getting ready...' : phase === 'listening' ? 'Listening...' : phase === 'thinking' ? 'Thinking...' : '';

  return (
    <View style={styles.root}>
      <Pressable style={styles.scrim} onPress={finish} />
      <View style={styles.sheet}>
        <View style={styles.glowOuter} />
        <View style={styles.glowInner} />
        <Pressable style={styles.close} onPress={finish}>
          <Text style={styles.closeText}>x</Text>
        </Pressable>
        <Bars amp={amp} />
        <Text style={styles.heard} numberOfLines={3}>
          {heard || hint}
        </Text>
        {!!reply && (
          <Text style={styles.reply} numberOfLines={6}>
            {reply}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'transparent'},
  scrim: {flex: 1, backgroundColor: 'transparent'},
  sheet: {
    backgroundColor: 'rgba(22,22,30,0.97)',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 44,
    minHeight: 230,
    alignItems: 'center',
    overflow: 'hidden',
  },
  glowOuter: {
    position: 'absolute',
    top: -2,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: '#4285F4',
    opacity: 0.9,
  },
  glowInner: {
    position: 'absolute',
    top: 2,
    left: 40,
    right: 40,
    height: 3,
    backgroundColor: '#EA4335',
    opacity: 0.6,
    borderRadius: 3,
  },
  close: {position: 'absolute', top: 14, right: 18, padding: 8},
  closeText: {color: '#9AA0A6', fontSize: 20},
  bars: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 70, gap: 10},
  bar: {width: 12, borderRadius: 6},
  heard: {color: '#FFFFFF', fontSize: 20, fontWeight: '600', marginTop: 18, textAlign: 'center'},
  reply: {color: '#C4C7CC', fontSize: 16, marginTop: 10, textAlign: 'center', lineHeight: 22},
});
