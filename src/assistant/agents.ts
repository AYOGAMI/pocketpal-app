import {AppRegistry, NativeModules} from 'react-native';

import {asrStore} from '../store';
import {whisperAsrEngine} from '../services/asr';

import {beginSession, complete, ensureModel, loadWhisper, offloadModel, setS, unloadWhisper} from './AssistRoot';
import {loadSettings} from './settingsShared';

// Background AI conversations: the AI texts back to callers, and (experimental) answers calls.

const N: any = (NativeModules as any).AssistNative;
const log = (m: string) => {
  try {
    N?.helperLog(m);
  } catch (_e) {
    // ignore
  }
};

type ThreadT = {msgs: Array<{from: 'caller' | 'me'; text: string}>; replies: number};

const summarise = async (who: string, transcript: string): Promise<string> => {
  const out = await complete(
    [
      {
        role: 'user',
        content:
          'Write a short note (under 45 words) for the phone owner about this conversation with a caller: who they are, why they called, how urgent it is, and how to reach them. Plain text only.\n\n' +
          transcript,
      },
    ],
    110,
  );
  return out || transcript.slice(0, 200);
};

async function smsAgent(data: any) {
  const number = String(data?.number ?? '');
  const who = String(data?.who ?? number);
  const text = String(data?.text ?? '').trim();
  try {
    const S = await loadSettings();
    setS(S);
    beginSession();
    log('Caller wrote: ' + text.slice(0, 80));
    let thread: ThreadT = {msgs: [], replies: 0};
    try {
      const raw = await N.getSmsThread(number);
      if (raw) {
        thread = JSON.parse(raw);
      }
    } catch (_e) {
      // new thread
    }
    thread.msgs.push({from: 'caller', text});
    const maxReplies = Math.max(1, S.smsMaxReplies);
    const ok = await ensureModel().catch(() => false);
    if (!ok) {
      const line = 'Reason from ' + who + ': ' + text;
      await N.addNote(line);
      await N.postNotice('Why they called', line);
      await N.clearSmsThread(number);
      log('No model could be loaded, saved the caller text as it was');
      return;
    }
    const system =
      'You are an assistant answering text messages for the owner of this phone, who is busy. A person who just phoned is texting back. ' +
      'Find out: ' + S.smsDetails + '. Ask for only ONE missing thing per text. Keep every text under 200 characters, friendly and plain. ' +
      'Promise nothing except that the owner will get back to them. When you know enough, or they have nothing more to say, thank them and end your text with [DONE]. ' +
      'Your first text to them was: "' + S.callSmsText + '"';
    const messages: any[] = [{role: 'system', content: system}].concat(
      thread.msgs.map(m => ({role: m.from === 'caller' ? 'user' : 'assistant', content: m.text})),
    );
    let reply = await complete(messages, 100);
    let done = /\[DONE\]/i.test(reply) || thread.replies + 1 >= maxReplies;
    reply = reply.replace(/\[DONE\]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!reply) {
      reply = 'Thank you, I will pass this on.';
      done = true;
    }
    if (done && !/thank/i.test(reply)) {
      reply = (reply + ' Thank you, I will pass this on.').slice(0, 320);
    }
    await N.sendSms(number, reply);
    thread.msgs.push({from: 'me', text: reply});
    thread.replies += 1;
    if (done) {
      const transcript = thread.msgs.map(m => (m.from === 'caller' ? 'Caller: ' : 'Assistant: ') + m.text).join('\n');
      const summary = await summarise(who, transcript);
      const note = 'Follow-up from ' + who + ': ' + summary;
      await N.addNote(note);
      await N.postNotice('Why they called', note);
      await N.clearSmsThread(number);
      log('Conversation finished and saved to notes');
    } else {
      await N.saveSmsThread(number, JSON.stringify(thread));
      log('Asked a follow-up question');
    }
  } catch (e: any) {
    log('Text conversation problem: ' + String(e?.message ?? e).slice(0, 120));
  } finally {
    await offloadModel();
  }
}

// EXPERIMENTAL: answers the call, speaks through the speaker, listens through the microphone.
async function callAgent(data: any) {
  const number = String(data?.number ?? '');
  const who = String(data?.who ?? 'an unknown number');
  try {
    const S = await loadSettings();
    setS(S);
    beginSession();
    log('Call agent starting for ' + who);
    try {
      await (asrStore as any).init();
    } catch (_e) {
      // already initialised
    }
    if (!asrStore.isSelectedTierReady) {
      log('Speech model is not set up. Open PocketPal once and finish the voice setup.');
      await N.addNote('Missed call from ' + who + '. The AI could not answer: speech model not set up.');
      return;
    }
    const tier = asrStore.selectedTier;
    await Promise.all([loadWhisper(tier).catch(() => {}), ensureModel().catch(() => false)]);
    if (!(await N.isRinging())) {
      log('The caller hung up before the AI was ready');
      await N.addNote('Missed call from ' + who + '. They hung up before the AI could answer.');
      return;
    }
    const answered = await N.answerCall();
    if (!answered) {
      log('Could not answer the call');
      await N.endCallNow();
      await N.addNote('Missed call from ' + who + '. The AI could not answer it.');
      return;
    }
    await N.speak(S.callGreeting);
    const lines: string[] = [];
    const turns = Math.max(1, S.callTurns);
    for (let turn = 0; turn < turns; turn++) {
      const pcm: string = await N.listen(16000, 1400, 9000);
      const lvl = Number(await N.getLastLevel());
      if (!pcm) {
        log('No speech heard (loudest sound level ' + Math.round(lvl) + '). If this stays near 0 the phone blocks the microphone during calls: turn on the accessibility service.');
        break;
      }
      const tr: any = await whisperAsrEngine.transcribe(pcm, {tier, language: asrStore.spokenLanguage ?? undefined});
      const said = String(tr?.text ?? '').trim();
      log('Caller said: ' + said.slice(0, 80));
      if (!said) {
        break;
      }
      lines.push('Caller: ' + said);
      let reply = 'Thank you. I will pass this on. Goodbye.';
      if (turn < turns - 1) {
        const sys =
          'You are answering a phone call for the owner of this phone, who is busy. Find out: ' + S.smsDetails +
          '. Say ONE short spoken sentence (under 25 words): thank them and ask for the single most important missing detail. If you have everything, say a friendly goodbye.';
        const msgs: any[] = [{role: 'system', content: sys}].concat(
          lines.map(l => ({role: l.startsWith('Caller: ') ? 'user' : 'assistant', content: l.replace(/^(Caller|Assistant): /, '')})),
        );
        reply = (await complete(msgs, 60)) || reply;
      }
      lines.push('Assistant: ' + reply);
      await N.speak(reply);
    }
    const transcript = lines.join('\n');
    const note = transcript
      ? 'Call from ' + who + ': ' + (await summarise(who, transcript))
      : 'Missed call from ' + who + '. The AI answered but heard nothing.';
    await N.addNote(note);
    await N.postNotice('Call answered by PocketPal', note);
    await N.endCallNow();
    log('Call finished and saved to notes');
  } catch (e: any) {
    log('Call agent problem: ' + String(e?.message ?? e).slice(0, 120));
    try {
      await N.endCallNow();
    } catch (_e) {
      // ignore
    }
  } finally {
    await unloadWhisper();
    await offloadModel();
  }
}

AppRegistry.registerHeadlessTask('PocketPalSmsAgent', () => smsAgent);
AppRegistry.registerHeadlessTask('PocketPalCallAgent', () => callAgent);
