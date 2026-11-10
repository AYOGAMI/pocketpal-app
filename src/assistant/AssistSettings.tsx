import React, {useEffect, useState} from 'react';
import {
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {modelStore, palStore} from '../store';
import {AssistSettingsT, DEFAULTS, SkillT, loadSettings, saveSettings} from './settingsShared';

const N: any = (NativeModules as any).AssistNative;

const Row: React.FC<{title: string; hint?: string; children?: React.ReactNode}> = ({title, hint, children}) => (
  <View style={st.row}>
    <View style={st.rowText}>
      <Text style={st.title}>{title}</Text>
      {!!hint && <Text style={st.hint}>{hint}</Text>}
    </View>
    {children}
  </View>
);

const Chips: React.FC<{options: Array<[string, any]>; value: any; onPick: (v: any) => void}> = ({options, value, onPick}) => (
  <View style={st.chips}>
    {options.map(([label, v]) => (
      <Pressable key={label} onPress={() => onPick(v)} style={[st.chip, value === v && st.chipOn]}>
        <Text style={[st.chipText, value === v && st.chipTextOn]}>{label}</Text>
      </Pressable>
    ))}
  </View>
);

const Section: React.FC<{title: string}> = ({title}) => <Text style={st.section}>{title}</Text>;

export default function AssistSettings() {
  const [s, setS] = useState<AssistSettingsT>(DEFAULTS);
  const [models, setModels] = useState<Array<{id: string; name: string}>>([]);
  const [pals, setPals] = useState<Array<{id: string; name: string}>>([]);
  const [visionModels, setVisionModels] = useState<Array<{id: string; name: string}>>([]);
  const [msg, setMsg] = useState('');
  const [helperOn, setHelperOn] = useState(false);
  const [notes, setNotes] = useState('');
  const [secText, setSecText] = useState('20');
  const [diag, setDiag] = useState('');
  const [a11y, setA11y] = useState(false);
  const [draft, setDraft] = useState<{name: string; phrases: string; type: SkillT['type']; value: string}>({
    name: '',
    phrases: '',
    type: 'app',
    value: '',
  });

  useEffect(() => {
    loadSettings().then(v => {
      setS(v);
      setSecText(String(v.callSeconds));
    });
    N?.callHelperRunning().then(setHelperOn).catch(() => {});
    const t = setInterval(() => {
      N?.callHelperRunning().then(setHelperOn).catch(() => {});
      N?.accessibilityOn().then(setA11y).catch(() => {});
      const list: any[] = (modelStore as any).models ?? [];
      setModels(list.filter(m => m.isDownloaded).map(m => ({id: m.id, name: m.name ?? m.id})));
      setVisionModels(
        list
          .filter(m => m.isDownloaded && (m.supportsMultimodal || m.defaultProjectionModel || m.visionEnabled))
          .map(m => ({id: m.id, name: m.name ?? m.id})),
      );
      const pl: any[] = (palStore as any).pals ?? [];
      setPals(pl.map(p => ({id: p.id, name: p.name ?? p.id})));
    }, 800);
    return () => clearInterval(t);
  }, []);

  const set = (patch: Partial<AssistSettingsT>) => {
    const next = {...s, ...patch};
    setS(next);
    saveSettings(next);
  };

  const addSkill = () => {
    if (!draft.name.trim() || !draft.phrases.trim() || !draft.value.trim()) {
      setMsg('Fill in the name, the phrases and what it should do.');
      return;
    }
    const sk: SkillT = {id: String(Date.now()), ...draft};
    set({skills: [...(s.skills ?? []), sk]});
    setDraft({...draft, name: '', phrases: '', value: ''});
    setMsg('Skill added. Say one of its phrases to try it.');
  };

  const valueHint =
    draft.type === 'app'
      ? 'App name, for example YouTube'
      : draft.type === 'link'
      ? 'Web address. Use {q} for the words you say after the phrase, for example https://www.amazon.com/s?k={q}'
      : draft.type === 'say'
      ? 'What the assistant should say back'
      : 'Instruction for the AI, for example: Answer like a friendly pirate';

  const toggleHelper = async () => {
    const res: string = await N.callHelper(!helperOn);
    setMsg(res);
    setTimeout(() => N.callHelperRunning().then(setHelperOn).catch(() => {}), 600);
  };

  return (
    <ScrollView style={st.root} contentContainerStyle={st.content}>
      <Text style={st.h1}>PocketPal Assistant</Text>
      <Text style={st.sub}>Everything here has a sensible default. Change what you like.</Text>

      <Section title="Who answers" />
      <Row title="Assistant persona" hint="Default is the plain PocketPal assistant. Pick one of your Pals to give the assistant its personality.">
        <Chips options={[['Default', 'default'], ...pals.map(p => [p.name, p.id] as [string, any])]} value={s.personaId} onPick={v => set({personaId: v})} />
      </Row>
      <Row title="Conversation" hint="One question: answers and closes. Follow-ups: waits a few seconds for more. Continuous: keeps chatting until you say stop or tap outside.">
        <Chips options={[['One question', 'one'], ['Follow-ups', 'follow'], ['Continuous', 'continuous']]} value={s.conversation} onPick={v => set({conversation: v})} />
      </Row>
      {s.conversation === 'continuous' && (
        <>
          <Row title="Close after silence" hint="How long it waits before ending a continuous chat.">
            <Chips options={[['30 s', 30], ['1 min', 60], ['2 min', 120], ['5 min', 300]]} value={s.idleSeconds} onPick={v => set({idleSeconds: v})} />
          </Row>
          <Row title="Keep the model loaded during the chat" hint="Faster replies, but uses more battery. It is always unloaded when the panel closes.">
            <Switch value={s.keepModel} onValueChange={v => set({keepModel: v})} />
          </Row>
        </>
      )}

      <Section title="Voice and listening" />
      <Row title="Use PocketPal's own voice" hint="Off = your phone's built-in voice (faster to start).">
        <Switch value={s.usePocketVoice} onValueChange={v => set({usePocketVoice: v})} />
      </Row>
      <Row title="Wait after you stop talking" hint="How long it waits before it answers.">
        <Chips options={[['Quick', 500], ['Normal', 750], ['Patient', 1200]]} value={s.silenceMs} onPick={v => set({silenceMs: v})} />
      </Row>
      <Row title="Phone actions" hint="Open apps, maps, alarms, calls, texts, email, flashlight and more.">
        <Switch value={s.phoneActions} onValueChange={v => set({phoneActions: v})} />
      </Row>

      <Section title="AI model and battery" />
      <Row title="Model for the assistant" hint="Auto picks your smallest downloaded model: least memory and battery.">
        <Chips options={[['Auto (smallest)', 'auto'], ...models.map(m => [m.name, m.id] as [string, any])]} value={s.modelId} onPick={v => set({modelId: v})} />
      </Row>
      <Row title="Unload the model right after each answer" hint="Saves battery and memory. The model is always unloaded when you close the panel.">
        <Switch value={s.unloadAfterAnswer} onValueChange={v => set({unloadAfterAnswer: v})} />
      </Row>

      <Section title="Look" />
      <Row title="Frosted glass look" hint="Blurs the app behind the assistant and gives the caption a glass edge. Needs Android 12 or newer.">
        <Switch value={s.glass} onValueChange={v => set({glass: v})} />
      </Row>
      {s.glass && (
        <Row title="Glass colour" hint="PocketPal colours, or the colours of your phone's theme.">
          <Chips options={[['PocketPal', 'app'], ['Phone theme', 'system']]} value={s.glassTint} onPick={v => set({glassTint: v})} />
        </Row>
      )}
      {s.glass && (
        <Row title="Glass bending" hint="How much the glass bends the app behind it. Needs Android 13 and the use screenshot setting.">
          <Chips options={[['Subtle', 8], ['Normal', 14], ['Strong', 24]]} value={s.glassRefract} onPick={v => set({glassRefract: v})} />
        </Row>
      )}
      {s.glass && (
        <Row title="Glass blur strength">
          <Chips options={[['Light', 12], ['Medium', 25], ['Strong', 45]]} value={s.glassBlur} onPick={v => set({glassBlur: v})} />
        </Row>
      )}
      <Row title="Dark shade at the bottom">
        <Switch value={s.showShade} onValueChange={v => set({showShade: v})} />
      </Row>
      <Row title="Colour glow at the bottom">
        <Switch value={s.showGlow} onValueChange={v => set({showGlow: v})} />
      </Row>
      <Row title="Cloud size">
        <Chips options={[['Small', 0.8], ['Normal', 1], ['Big', 1.25]]} value={s.cloudSize} onPick={v => set({cloudSize: v})} />
      </Row>

      <Section title="Reading your screen and notifications" />
      <Row title="Notification access" hint="Needed for 'read my notifications'.">
        <Pressable style={st.btn} onPress={() => N.perform('settings', JSON.stringify({page: 'notification_access'}))}>
          <Text style={st.btnText}>Open</Text>
        </Pressable>
      </Row>
      <Row title="Use text from screen" hint="Turn this on in the default assistant settings so it can read the screen.">
        <Pressable style={st.btn} onPress={() => N.perform('settings', JSON.stringify({page: 'assistant'}))}>
          <Text style={st.btnText}>Open</Text>
        </Pressable>
      </Row>

      <Section title="Call helper" />
      <Text style={st.note}>
        Android does not let any app answer a call and talk to the caller. So the helper does the closest thing: if you ignore a
        call, it declines it, texts the caller, and saves who called and why in your notes, even when the phone is locked.
      </Text>
      <Row title={helperOn ? 'Call helper is ON' : 'Call helper is OFF'} hint={helperOn ? 'Running now. Ignored calls are declined after the wait below.' : 'Tap Turn on, then allow every permission Android asks for.'}>
        <Pressable style={[st.btn, helperOn && st.btnOn]} onPress={toggleHelper}>
          <Text style={st.btnText}>{helperOn ? 'Turn off' : 'Turn on'}</Text>
        </Pressable>
      </Row>
      <Row title="Wait before declining" hint="Seconds the phone rings before the helper acts. Pick one or type your own (5 to 120).">
        <Chips
          options={[['10 s', 10], ['20 s', 20], ['30 s', 30], ['45 s', 45], ['60 s', 60]]}
          value={s.callSeconds}
          onPick={v => {
            set({callSeconds: v});
            setSecText(String(v));
          }}
        />
      </Row>
      <View style={st.secRow}>
        <Text style={st.title}>Custom seconds</Text>
        <TextInput
          style={st.secInput}
          keyboardType="number-pad"
          value={secText}
          onChangeText={v => setSecText(v.replace(/\D/g, '').slice(0, 3))}
          onEndEditing={() => {
            const n = Math.max(5, Math.min(120, parseInt(secText || '20', 10) || 20));
            setSecText(String(n));
            set({callSeconds: n});
          }}
        />
      </View>
      <Row title="Also handle callers who hang up first" hint="If the caller gives up before the wait is over, still text them and save a note.">
        <Switch value={s.callOnMissed} onValueChange={v => set({callOnMissed: v})} />
      </Row>
      <Row title="Keep the helper on" hint="Starts it again after the phone restarts. Also allow background running so Android does not stop it.">
        <Switch value={s.callAlways} onValueChange={v => set({callAlways: v})} />
      </Row>
      <View style={st.btnRow}>
        <Pressable style={st.btn} onPress={() => N.perform('settings', JSON.stringify({page: 'battery'}))}>
          <Text style={st.btnText}>Allow background running</Text>
        </Pressable>
        <Pressable style={st.btn} onPress={async () => setDiag(String(await N.callHelperStatus()))}>
          <Text style={st.btnText}>Check permissions</Text>
        </Pressable>
      </View>
      <View style={[st.btnRow, {marginTop: 10}]}>
        <Pressable style={st.btn} onPress={async () => setDiag(String((await N.getHelperLog()) || 'The helper log is empty. Nothing has happened yet.'))}>
          <Text style={st.btnText}>Show helper log</Text>
        </Pressable>
        <Pressable style={st.btn} onPress={async () => { await N.clearHelperLog(); setDiag('Log cleared.'); }}>
          <Text style={st.btnText}>Clear log</Text>
        </Pressable>
      </View>
      {!!diag && <Text style={st.notes}>{diag}</Text>}
      <Row title="When a call is ignored" hint="Decline and text is reliable. Answer and talk is experimental: the AI answers, speaks through the speaker and listens through the microphone. It may not hear the caller on some phones.">
        <Chips options={[['Decline and text', 'text'], ['Answer and talk (experimental)', 'answer']]} value={s.callMode} onPick={v => set({callMode: v})} />
      </Row>
      {s.callMode === 'answer' && (
        <>
          <Text style={st.hint}>What the AI says first</Text>
          <TextInput style={st.input} multiline value={s.callGreeting} onChangeText={v => set({callGreeting: v})} placeholderTextColor="#777" />
          <Row title="Questions it asks" hint="How many times it listens and replies before saying goodbye.">
            <Chips options={[['1', 1], ['2', 2], ['3', 3], ['4', 4]]} value={s.callTurns} onPick={v => set({callTurns: v})} />
          </Row>
          <Row title={a11y ? 'Accessibility service is ON' : 'Accessibility service is OFF'} hint="Needed so the microphone works during a call. Open it, find PocketPal, and turn it on. On newer Android, first allow restricted settings in PocketPal's app info.">
            <Pressable style={[st.btn, a11y && st.btnOn]} onPress={() => N.perform('settings', JSON.stringify({page: 'accessibility'}))}>
              <Text style={st.btnText}>Open</Text>
            </Pressable>
          </Row>
        </>
      )}
      <Row title="AI keeps texting the caller" hint="When a caller texts back, the AI replies, asks for missing details, and saves a short note. It also answers RCS and WhatsApp chats through the notification's Reply button, so turn on notification access.">
        <Switch value={s.smsAgent} onValueChange={v => set({smsAgent: v})} />
      </Row>
      {s.smsAgent && (
        <>
          <Row title="Most replies per caller">
            <Chips options={[['1', 1], ['2', 2], ['3', 3], ['5', 5]]} value={s.smsMaxReplies} onPick={v => set({smsMaxReplies: v})} />
          </Row>
          <Text style={st.hint}>Details the AI should find out</Text>
          <TextInput style={st.input} multiline value={s.smsDetails} onChangeText={v => set({smsDetails: v})} placeholderTextColor="#777" />
        </>
      )}
      <Row title="Decline the call">
        <Switch value={s.callDecline} onValueChange={v => set({callDecline: v})} />
      </Row>
      <Row title="Text the caller">
        <Switch value={s.callSms} onValueChange={v => set({callSms: v})} />
      </Row>
      <Text style={st.hint}>Message to send</Text>
      <TextInput style={st.input} multiline value={s.callSmsText} onChangeText={v => set({callSmsText: v})} placeholderTextColor="#777" />
      <Row title="Save who called and why in my notes">
        <Switch value={s.callNote} onValueChange={v => set({callNote: v})} />
      </Row>
      <Row title="Show a notification with the reason">
        <Switch value={s.callNotify} onValueChange={v => set({callNotify: v})} />
      </Row>

      <Section title="Circle to search, screenshots and screen vision" />
      <Text style={st.note}>
        With the assistant open, draw a circle with your finger anywhere on the screen. What you circled is sent where you choose
        below. A short tap closes the assistant. Say "take a screenshot" to save the screen. Say "view my screen" and a vision model
        looks at the screen and answers; the picture is deleted straight afterwards. These need "use screenshot" turned on in
        Android's default assistant settings.
      </Text>
      <Row title="After circling">
        <Chips options={[['Ask me', 'ask'], ['Google Lens', 'lens'], ['Choose app', 'chooser'], ['Save', 'save']]} value={s.circleTarget} onPick={v => set({circleTarget: v})} />
      </Row>
      <Row title="View my screen with a vision model" hint="Off = it only reads the text on the screen.">
        <Switch value={s.screenVision} onValueChange={v => set({screenVision: v})} />
      </Row>
      {s.screenVision && (
        <Row title="Vision model" hint="Auto picks your first downloaded model that can see pictures. Download one in PocketPal if the list is empty.">
          <Chips options={[['Auto', 'auto'], ...visionModels.map(m => [m.name, m.id] as [string, any])]} value={s.visionModelId} onPick={v => set({visionModelId: v})} />
        </Row>
      )}
      <Text style={st.hint}>Always send to this app (optional, the app's package name)</Text>
      <TextInput style={st.input1} placeholder="for example com.google.android.googlequicksearchbox" placeholderTextColor="#777" value={s.circlePackage} onChangeText={v => set({circlePackage: v.trim()})} />
      <Row title="Use screenshot setting" hint="Open Android's default assistant settings and turn on use screenshot and use text from screen.">
        <Pressable style={st.btn} onPress={() => N.perform('settings', JSON.stringify({page: 'assistant'}))}>
          <Text style={st.btnText}>Open</Text>
        </Pressable>
      </Row>

      <Section title="My skills" />
      <Text style={st.note}>
        Teach the assistant your own commands. Example: phrases "open my bank", does "Open an app", value "MyBank". Or phrases
        "search amazon for", does "Open a web link", value https://www.amazon.com/s?k={'{q}'}
      </Text>
      {(s.skills ?? []).map(sk => (
        <View key={sk.id} style={st.skill}>
          <View style={st.rowText}>
            <Text style={st.title}>{sk.name}</Text>
            <Text style={st.hint}>Say: {sk.phrases}</Text>
            <Text style={st.hint}>{sk.type === 'app' ? 'Opens app' : sk.type === 'link' ? 'Opens link' : sk.type === 'say' ? 'Says' : 'Asks the AI'}: {sk.value}</Text>
          </View>
          <Pressable style={st.btn} onPress={() => set({skills: (s.skills ?? []).filter(x => x.id !== sk.id)})}>
            <Text style={st.btnText}>Delete</Text>
          </Pressable>
        </View>
      ))}
      <Text style={st.hint}>New skill</Text>
      <TextInput style={st.input1} placeholder="Name, for example Night mode" placeholderTextColor="#777" value={draft.name} onChangeText={v => setDraft({...draft, name: v})} />
      <TextInput style={st.input1} placeholder="Phrases, separated by commas: good night, night mode" placeholderTextColor="#777" value={draft.phrases} onChangeText={v => setDraft({...draft, phrases: v})} />
      <Chips
        options={[['Open an app', 'app'], ['Open a web link', 'link'], ['Say something', 'say'], ['Ask the AI', 'ai']]}
        value={draft.type}
        onPick={v => setDraft({...draft, type: v})}
      />
      <TextInput style={st.input1} placeholder={valueHint} placeholderTextColor="#777" value={draft.value} onChangeText={v => setDraft({...draft, value: v})} />
      <Pressable style={[st.btn, st.btnOn, st.add]} onPress={addSkill}>
        <Text style={st.btnText}>Add skill</Text>
      </Pressable>

      <Section title="My notes" />
      <View style={st.btnRow}>
        <Pressable style={st.btn} onPress={async () => setNotes(String((await N.getNotes()) || 'No notes yet.'))}>
          <Text style={st.btnText}>Show notes</Text>
        </Pressable>
        <Pressable style={st.btn} onPress={async () => { await N.clearNotes(); setNotes('Notes cleared.'); }}>
          <Text style={st.btnText}>Clear notes</Text>
        </Pressable>
      </View>
      {!!notes && <Text style={st.notes}>{notes}</Text>}

      <Pressable style={[st.btn, st.reset]} onPress={() => { setS(DEFAULTS); saveSettings(DEFAULTS); setMsg('Back to the default settings.'); }}>
        <Text style={st.btnText}>Reset everything to defaults</Text>
      </Pressable>
      {!!msg && <Text style={st.msg}>{msg}</Text>}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0F0F17'},
  content: {padding: 20, paddingBottom: 60},
  h1: {color: '#FFFFFF', fontSize: 26, fontWeight: '700', marginTop: 20},
  sub: {color: '#9A9DB0', marginTop: 6, marginBottom: 8},
  section: {color: '#B9A8FF', fontSize: 14, fontWeight: '700', marginTop: 26, marginBottom: 6, textTransform: 'uppercase'},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, gap: 12, flexWrap: 'wrap'},
  rowText: {flex: 1, minWidth: 180},
  title: {color: '#FFFFFF', fontSize: 16},
  hint: {color: '#8E91A5', fontSize: 12, marginTop: 3},
  note: {color: '#C9CBD8', fontSize: 13, lineHeight: 19, marginBottom: 6},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end'},
  chip: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: '#1D1D2B'},
  chipOn: {backgroundColor: '#7C5CFF'},
  chipText: {color: '#C9CBD8', fontSize: 13},
  chipTextOn: {color: '#FFFFFF', fontWeight: '700'},
  btn: {paddingHorizontal: 16, paddingVertical: 9, borderRadius: 18, backgroundColor: '#2A2A3D'},
  btnOn: {backgroundColor: '#7C5CFF'},
  btnText: {color: '#FFFFFF', fontSize: 14},
  btnRow: {flexDirection: 'row', gap: 10},
  input: {color: '#FFFFFF', backgroundColor: '#1D1D2B', borderRadius: 12, padding: 12, marginTop: 6, minHeight: 70, textAlignVertical: 'top'},
  notes: {color: '#D8DAE0', marginTop: 12, lineHeight: 20},
  skill: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#161622', borderRadius: 12, padding: 12, marginBottom: 8},
  secRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6},
  secInput: {color: '#FFFFFF', backgroundColor: '#1D1D2B', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, minWidth: 80, textAlign: 'center', fontSize: 16},
  input1: {color: '#FFFFFF', backgroundColor: '#1D1D2B', borderRadius: 12, padding: 12, marginTop: 8},
  add: {marginTop: 12, alignSelf: 'flex-start'},
  reset: {marginTop: 28, alignSelf: 'flex-start'},
  msg: {color: '#FFD580', marginTop: 14, lineHeight: 19},
});
