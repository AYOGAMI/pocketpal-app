package com.pocketpal

import android.Manifest
import android.app.Notification
import android.app.SearchManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.telephony.SmsManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.BatteryManager
import android.os.Bundle
import android.os.Build
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.sqrt

// Native helpers for the PocketPal assistant: microphone with end-of-speech detection,
// the phone's own voice for answers, and the phone actions (apps, maps, alarms, ...).
class AssistModule(private val rc: ReactApplicationContext) : ReactContextBaseJavaModule(rc) {

    override fun getName(): String = "AssistNative"

    init {
        try {
            val prev = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { t, e ->
                try { saveCrash("App crash in thread " + t.name + "\n" + android.util.Log.getStackTraceString(e)) } catch (_: Exception) {}
                prev?.uncaughtException(t, e)
            }
        } catch (_: Exception) {
        }
    }

    // Saves crash details as Download/pocketpal-crash-*.txt (read it from Termux with: cat ~/storage/downloads/pocketpal-crash-*.txt)
    private fun saveCrash(text: String) {
        if (Build.VERSION.SDK_INT < 29) return
        val v = ContentValues()
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, "pocketpal-crash-" + System.currentTimeMillis() + ".txt")
        v.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download")
        val uri = rc.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: return
        rc.contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
    }

    @ReactMethod
    fun writeCrash(text: String) {
        Thread { try { saveCrash(text) } catch (_: Exception) {} }.start()
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    private fun emitLevel(value: Double) {
        try {
            rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("AssistLevel", value)
        } catch (_: Exception) {
        }
    }

    // ------------------------------------------------------------ microphone
    @Volatile private var stopRequested = false
    @Volatile private var lastMaxRms = 0.0

    @ReactMethod
    fun stopListening() {
        stopRequested = true
    }

    private fun writeShorts(out: ByteArrayOutputStream, s: ShortArray) {
        for (v in s) {
            out.write(v.toInt() and 0xFF)
            out.write((v.toInt() shr 8) and 0xFF)
        }
    }

    // Resolves with base64 16 kHz mono PCM16 of one spoken sentence, or "" if nobody spoke.
    @ReactMethod
    fun listen(maxMs: Int, silenceMs: Int, firstWordMs: Int, promise: Promise) {
        if (ContextCompat.checkSelfPermission(rc, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            promise.reject("no_mic", "Microphone permission is missing. Open PocketPal once and allow the microphone.")
            return
        }
        Thread {
            var rec: AudioRecord? = null
            try {
                val rate = 16000
                val minBuf = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                rec = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION, rate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, 640 * 8)
                )
                if (rec.state != AudioRecord.STATE_INITIALIZED) {
                    promise.reject("mic_init", "Could not start the microphone.")
                    return@Thread
                }
                stopRequested = false
                lastMaxRms = 0.0
                rec.startRecording()
                val out = ByteArrayOutputStream()
                val pre = java.util.ArrayDeque<ShortArray>()
                val frame = ShortArray(320)
                var floor = 0.0
                var n = 0
                var speaking = false
                var silentMs = 0
                var voicedMs = 0
                var elapsed = 0
                while (!stopRequested && elapsed < maxMs) {
                    val r = rec.read(frame, 0, frame.size)
                    if (r <= 0) break
                    var sum = 0.0
                    for (i in 0 until r) sum += frame[i].toDouble() * frame[i].toDouble()
                    val rms = sqrt(sum / r)
                    elapsed += 20
                    if (rms > lastMaxRms) lastMaxRms = rms
                    if ((elapsed / 20) % 3 == 0) emitLevel(minOf(1.0, rms / 4000.0))
                    if (n < 15) {
                        floor += rms
                        n++
                        if (n == 15) floor = minOf(floor / 15.0, 600.0)
                    }
                    val thr = maxOf(450.0, floor * 3.5)
                    val copy = frame.copyOf(r)
                    if (!speaking) {
                        pre.addLast(copy)
                        if (pre.size > 15) pre.removeFirst()
                        if (n >= 15 && rms > thr) {
                            speaking = true
                            voicedMs = 20
                            silentMs = 0
                            for (c in pre) writeShorts(out, c)
                            pre.clear()
                        } else if (elapsed >= firstWordMs) {
                            break
                        }
                    } else {
                        writeShorts(out, copy)
                        if (rms > thr * 0.6) {
                            silentMs = 0
                            voicedMs += 20
                        } else {
                            silentMs += 20
                        }
                        if (silentMs >= silenceMs) break
                    }
                }
                try { rec.stop() } catch (_: Exception) {}
                rec.release()
                rec = null
                if (!speaking || voicedMs < 200) {
                    promise.resolve("")
                } else {
                    promise.resolve(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                }
            } catch (e: Exception) {
                try { rec?.release() } catch (_: Exception) {}
                promise.reject("listen_failed", e.message ?: "listen failed")
            }
        }.start()
    }

    // ------------------------------------------------------------ the phone's voice
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsStarting = false
    private val waiting = ArrayList<(TextToSpeech?) -> Unit>()
    private val pending = ConcurrentHashMap<String, Promise>()
    private val synthDone = ConcurrentHashMap<String, (Boolean) -> Unit>()

    private fun withTts(done: (TextToSpeech?) -> Unit) {
        val cur = tts
        if (cur != null && ttsReady) {
            done(cur)
            return
        }
        synchronized(waiting) { waiting.add(done) }
        if (ttsStarting) return
        ttsStarting = true
        tts = TextToSpeech(rc.applicationContext) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            val t = tts
            if (ttsReady && t != null) {
                val lr = t.setLanguage(Locale.getDefault())
                if (lr == TextToSpeech.LANG_MISSING_DATA || lr == TextToSpeech.LANG_NOT_SUPPORTED) t.setLanguage(Locale.US)
                try {
                    t.setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANT)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
                    )
                } catch (_: Exception) {}
                t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        if (utteranceId != null) {
                            pending.remove(utteranceId)?.resolve(true)
                            synthDone.remove(utteranceId)?.invoke(true)
                        }
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        if (utteranceId != null) {
                            pending.remove(utteranceId)?.resolve(false)
                            synthDone.remove(utteranceId)?.invoke(false)
                        }
                    }
                })
            }
            val list = synchronized(waiting) { val c = ArrayList(waiting); waiting.clear(); c }
            for (w in list) w(if (ttsReady) t else null)
        }
    }

    @ReactMethod
    fun speak(text: String, promise: Promise) {
        withTts { t ->
            if (t == null) {
                promise.resolve(false)
                return@withTts
            }
            try {
                val am = rc.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                if (am.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) {
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, maxOf(2, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) / 3), 0)
                }
            } catch (_: Exception) {}
            val id = "u" + System.nanoTime()
            pending[id] = promise
            t.setSpeechRate(1.05f)
            val r = t.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
            if (r != TextToSpeech.SUCCESS) {
                pending.remove(id)
                promise.resolve(false)
            }
        }
    }

    // Speaks so the caller can hear it: loudspeaker, full volume, even during a call.
    @ReactMethod
    fun speakLoud(text: String, promise: Promise) {
        withTts { t ->
            if (t == null) {
                promise.resolve(false)
                return@withTts
            }
            Thread {
                var finished = false
                try {
                    val am = rc.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC), 0)
                    val file = java.io.File(rc.cacheDir, "assist_loud.wav")
                    if (file.exists()) file.delete()
                    val id = "s" + System.nanoTime()
                    val latch = java.util.concurrent.CountDownLatch(1)
                    var ok = false
                    synthDone[id] = { good -> ok = good; latch.countDown() }
                    val r = t.synthesizeToFile(text, null, file, id)
                    if (r != TextToSpeech.SUCCESS) {
                        synthDone.remove(id)
                        promise.resolve(false)
                        finished = true
                        return@Thread
                    }
                    latch.await(20, java.util.concurrent.TimeUnit.SECONDS)
                    if (!ok || !file.exists()) {
                        promise.resolve(false)
                        finished = true
                        return@Thread
                    }
                    var spk: AudioDeviceInfo? = null
                    for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                        if (d.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                            spk = d
                            break
                        }
                    }
                    val mp = android.media.MediaPlayer()
                    mp.setAudioAttributes(
                        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
                    )
                    mp.setDataSource(file.absolutePath)
                    if (spk != null && Build.VERSION.SDK_INT >= 28) mp.setPreferredDevice(spk)
                    mp.setVolume(1f, 1f)
                    val done = java.util.concurrent.CountDownLatch(1)
                    mp.setOnCompletionListener { done.countDown() }
                    mp.setOnErrorListener { _, _, _ -> done.countDown(); true }
                    mp.prepare()
                    mp.start()
                    done.await(60, java.util.concurrent.TimeUnit.SECONDS)
                    try { mp.release() } catch (e: Exception) {}
                    promise.resolve(true)
                    finished = true
                } catch (e: Exception) {
                    HelperLog.add(rc, "Loud speech failed: " + e.message)
                    if (!finished) promise.resolve(false)
                }
            }.start()
        }
    }

    @ReactMethod
    fun stopSpeaking() {
        try { tts?.stop() } catch (_: Exception) {}
        val ids = ArrayList(pending.keys)
        for (id in ids) pending.remove(id)?.resolve(false)
    }

    @ReactMethod
    fun close() {
        rc.currentActivity?.finish()
    }

    // ------------------------------------------------------------ phone actions
    @Volatile private var ok = false

    private fun start(i: Intent): Boolean {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            rc.startActivity(i)
            ok = true
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun norm(s: String): String = s.lowercase().replace(Regex("[^a-z0-9]"), "")

    private fun openApp(name: String): String {
        val want = norm(name)
        if (want.isEmpty()) return "Which app?"
        val pm = rc.packageManager
        val list = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        var best: ResolveInfo? = null
        var bs = 0
        for (ri in list) {
            val label = norm(ri.loadLabel(pm).toString())
            val sc = when {
                label == want -> 4
                label.startsWith(want) -> 3
                label.contains(want) -> 2
                label.length >= 3 && want.contains(label) -> 1
                else -> 0
            }
            if (sc > bs) {
                bs = sc
                best = ri
            }
        }
        val ri = best ?: return "I could not find an app called $name."
        val li = pm.getLaunchIntentForPackage(ri.activityInfo.packageName) ?: return "I could not open $name."
        return if (start(li)) "Opening " + ri.loadLabel(pm) else "I could not open $name."
    }

    private fun navigate(to: String): String {
        if (to.isBlank()) return "Where to?"
        val maps = Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + Uri.encode(to)))
        maps.setPackage("com.google.android.apps.maps")
        if (start(maps)) return "Starting navigation to $to"
        val geo = Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(to)))
        return if (start(geo)) "Showing $to on the map" else "I could not open a maps app."
    }

    private fun alarm(h: Int, m: Int, label: String): String {
        val i = Intent(AlarmClock.ACTION_SET_ALARM)
        i.putExtra(AlarmClock.EXTRA_HOUR, h)
        i.putExtra(AlarmClock.EXTRA_MINUTES, m)
        i.putExtra(AlarmClock.EXTRA_MESSAGE, label)
        i.putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        val hh = if (h % 12 == 0) 12 else h % 12
        val ap = if (h < 12) "AM" else "PM"
        return if (start(i)) String.format("Alarm set for %d:%02d %s", hh, m, ap) else "I could not set the alarm."
    }

    private fun timer(secs: Int): String {
        val i = Intent(AlarmClock.ACTION_SET_TIMER)
        i.putExtra(AlarmClock.EXTRA_LENGTH, secs)
        i.putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        val txt = if (secs % 3600 == 0) "${secs / 3600} hour" else if (secs % 60 == 0) "${secs / 60} minute" else "$secs second"
        return if (start(i)) "Timer set for $txt" else "I could not set the timer."
    }

    // null = no contacts permission yet, "" = not found, otherwise the number
    private fun resolveNumber(who: String): String? {
        if (Regex("^[+0-9 ()-]{5,}$").matches(who.trim())) return who.trim()
        if (ContextCompat.checkSelfPermission(rc, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            val act = rc.currentActivity
            if (act != null) ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.READ_CONTACTS), 77)
            return null
        }
        val c = rc.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
            arrayOf("%" + who.trim() + "%"), null
        )
        var found = ""
        c?.use { cur -> if (cur.moveToFirst()) found = cur.getString(0) ?: "" }
        return found
    }

    private fun call(who: String): String {
        val n = resolveNumber(who) ?: return "Please allow contacts access, then ask me again."
        if (n.isEmpty()) return "I could not find $who in your contacts."
        return if (start(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(n))))) "Calling $who" else "I could not open the dialer."
    }

    private fun sms(who: String, text: String): String {
        val n = resolveNumber(who) ?: return "Please allow contacts access, then ask me again."
        if (n.isEmpty()) return "I could not find $who in your contacts."
        val i = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(n)))
        i.putExtra("sms_body", text)
        return if (start(i)) "Message to $who is ready. Tap send." else "I could not open messages."
    }

    private fun torch(on: Boolean): String {
        val cm = rc.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        var id: String? = null
        for (c in cm.cameraIdList) {
            if (cm.getCameraCharacteristics(c).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true) {
                id = c
                break
            }
        }
        if (id == null) return "This phone has no flashlight."
        cm.setTorchMode(id, on)
        ok = true
        return if (on) "Flashlight on" else "Flashlight off"
    }

    private fun music(q: String): String {
        val i = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
        i.putExtra(SearchManager.QUERY, q)
        i.putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
        if (start(i)) return "Playing $q"
        val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(q)))
        return if (start(web)) "Searching YouTube for $q" else "I could not play $q."
    }

    private fun settingsPage(page: String): String {
        val (action, say) = when (page) {
            "wifi" -> Pair(Settings.ACTION_WIFI_SETTINGS, "Android only lets me open the Wi-Fi settings. Opening them.")
            "bluetooth" -> Pair(Settings.ACTION_BLUETOOTH_SETTINGS, "Android only lets me open the Bluetooth settings. Opening them.")
            "airplane" -> Pair(Settings.ACTION_AIRPLANE_MODE_SETTINGS, "Opening airplane mode settings.")
            "location" -> Pair(Settings.ACTION_LOCATION_SOURCE_SETTINGS, "Opening location settings.")
            "sound" -> Pair(Settings.ACTION_SOUND_SETTINGS, "Opening sound settings.")
            "display" -> Pair(Settings.ACTION_DISPLAY_SETTINGS, "Opening display settings.")
            "notification_access" -> Pair("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS", "Turn on PocketPal in notification access, then ask me again.")
            "battery" -> Pair(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS, "Find PocketPal in the list and choose do not optimize, so the call helper keeps running.")
            "accessibility" -> Pair(Settings.ACTION_ACCESSIBILITY_SETTINGS, "Turn on PocketPal in accessibility, then come back.")
            "assistant" -> Pair(Settings.ACTION_VOICE_INPUT_SETTINGS, "Open the default assistant settings and turn on use text from screen.")
            else -> Pair(Settings.ACTION_SETTINGS, "Opening settings.")
        }
        return if (start(Intent(action))) say else "I could not open settings."
    }

    private fun volume(dir: String): String {
        val am = rc.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        when (dir) {
            "down" -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
            "max" -> am.setStreamVolume(AudioManager.STREAM_MUSIC, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC), AudioManager.FLAG_SHOW_UI)
            "mute" -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
            else -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
        }
        ok = true
        return "Okay"
    }

    private fun emailAddress(who: String): String {
        val w = who.trim()
        if (w.isEmpty()) return ""
        val joined = w.lowercase().replace(" at ", "@").replace(" dot ", ".").replace(" ", "")
        if (Regex("^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$").matches(joined)) return joined
        if (ContextCompat.checkSelfPermission(rc, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            val act = rc.currentActivity
            if (act != null) ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.READ_CONTACTS), 78)
            return ""
        }
        val c = rc.contentResolver.query(
            ContactsContract.CommonDataKinds.Email.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
            ContactsContract.CommonDataKinds.Email.DISPLAY_NAME + " LIKE ?",
            arrayOf("%" + w + "%"), null
        )
        var found = ""
        c?.use { cur -> if (cur.moveToFirst()) found = cur.getString(0) ?: "" }
        return found
    }

    private fun email(to: String, subject: String, body: String): String {
        val addr = emailAddress(to)
        val i = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"))
        if (addr.isNotEmpty()) i.putExtra(Intent.EXTRA_EMAIL, arrayOf(addr))
        i.putExtra(Intent.EXTRA_SUBJECT, subject)
        i.putExtra(Intent.EXTRA_TEXT, body)
        return if (start(i)) "Your email draft is ready." else "I could not open a mail app."
    }

    // ------------------------------------------------------------ screen, notifications, notes
    @ReactMethod
    fun getScreenText(promise: Promise) {
        promise.resolve(PocketScreen.screenText)
    }

    @ReactMethod
    fun getNotifications(promise: Promise) {
        val svc = AssistNotificationService.instance
        if (svc == null) {
            promise.resolve("NOACCESS")
            return
        }
        try {
            val pm = rc.packageManager
            val sb = StringBuilder()
            var n = 0
            for (sbn in svc.activeNotifications) {
                if (sbn.packageName == rc.packageName) continue
                val nt = sbn.notification
                if ((nt.flags and Notification.FLAG_GROUP_SUMMARY) != 0) continue
                if (sbn.isOngoing) continue
                val ex = nt.extras
                val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
                val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
                if (title.isBlank() && text.isBlank()) continue
                val app = try { pm.getApplicationLabel(pm.getApplicationInfo(sbn.packageName, 0)).toString() } catch (e: Exception) { sbn.packageName }
                sb.append(app).append(": ").append(title)
                if (text.isNotBlank()) sb.append(" - ").append(text)
                sb.append("\n")
                n++
                if (n >= 25) break
            }
            promise.resolve(sb.toString())
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    private fun notes() = rc.getSharedPreferences("assist_notes", Context.MODE_PRIVATE)

    @ReactMethod
    fun addNote(text: String, promise: Promise) {
        val p = notes()
        val old = p.getString("all", "") ?: ""
        val stamp = java.text.SimpleDateFormat("d MMM HH:mm", Locale.getDefault()).format(java.util.Date())
        p.edit().putString("all", old + stamp + " - " + text.trim() + "\n").apply()
        promise.resolve(true)
    }

    @ReactMethod
    fun getNotes(promise: Promise) {
        promise.resolve(notes().getString("all", "") ?: "")
    }

    @ReactMethod
    fun clearNotes(promise: Promise) {
        notes().edit().remove("all").apply()
        promise.resolve(true)
    }

    // ------------------------------------------------------------ agents: calls, texts, screenshots
    @ReactMethod
    fun getLastLevel(promise: Promise) {
        promise.resolve(lastMaxRms)
    }

    @ReactMethod
    fun helperLog(msg: String) {
        HelperLog.add(rc, "[AI] " + msg)
    }

    @ReactMethod
    fun accessibilityOn(promise: Promise) {
        promise.resolve(AssistAccessibilityService.instance != null)
    }

    @ReactMethod
    fun isRinging(promise: Promise) {
        try {
            val t = rc.getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
            promise.resolve(t.callState == android.telephony.TelephonyManager.CALL_STATE_RINGING)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun answerCall(promise: Promise) {
        try {
            val tc = rc.getSystemService(Context.TELECOM_SERVICE) as android.telecom.TelecomManager
            tc.acceptRingingCall()
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                try {
                    val am = rc.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    am.isSpeakerphoneOn = true
                    if (Build.VERSION.SDK_INT >= 31) {
                        for (d in am.availableCommunicationDevices) {
                            if (d.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                                am.setCommunicationDevice(d)
                                break
                            }
                        }
                    }
                    HelperLog.add(rc, "Call answered, speakerphone on")
                } catch (e: Exception) {
                    HelperLog.add(rc, "Speakerphone failed: " + e.message)
                }
                promise.resolve(true)
            }, 1500)
        } catch (e: Exception) {
            HelperLog.add(rc, "Could not answer the call: " + e.message)
            promise.resolve(false)
        }
    }

    @Suppress("DEPRECATION")
    @ReactMethod
    fun endCallNow(promise: Promise) {
        try {
            val tc = rc.getSystemService(Context.TELECOM_SERVICE) as android.telecom.TelecomManager
            val done = tc.endCall()
            try {
                val am = rc.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                am.isSpeakerphoneOn = false
            } catch (e: Exception) {
            }
            HelperLog.add(rc, if (done) "Call ended" else "Android refused to end the call")
            promise.resolve(done)
        } catch (e: Exception) {
            HelperLog.add(rc, "Could not end the call: " + e.message)
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun sendSms(number: String, text: String, promise: Promise) {
        try {
            val sms: SmsManager = if (Build.VERSION.SDK_INT >= 31) rc.getSystemService(SmsManager::class.java) else SmsManager.getDefault()
            sms.sendMultipartTextMessage(number, null, sms.divideMessage(text), null, null)
            HelperLog.add(rc, "Text sent")
            promise.resolve(true)
        } catch (e: Exception) {
            HelperLog.add(rc, "Text failed: " + e.message)
            promise.resolve(false)
        }
    }

    private fun threadKey(number: String): String = number.filter { it.isDigit() }.takeLast(9)

    @ReactMethod
    fun getSmsThread(number: String, promise: Promise) {
        promise.resolve(rc.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).getString("t_" + threadKey(number), "") ?: "")
    }

    @ReactMethod
    fun saveSmsThread(number: String, json: String, promise: Promise) {
        rc.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit().putString("t_" + threadKey(number), json).apply()
        promise.resolve(true)
    }

    @ReactMethod
    fun clearSmsThread(number: String, promise: Promise) {
        val k = threadKey(number)
        rc.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit().remove("t_$k").remove("p_$k").remove("n_$k").apply()
        promise.resolve(true)
    }

    // answers an RCS or WhatsApp message through the notification's reply button
    @ReactMethod
    fun sendChatReply(key: String, text: String, promise: Promise) {
        try {
            val action = ReplyStore.actions[key]
            if (action == null) {
                HelperLog.add(rc, "No reply button is available for that chat")
                promise.resolve(false)
                return
            }
            val ris = action.remoteInputs
            val intent = Intent()
            val bundle = Bundle()
            for (ri in ris) bundle.putCharSequence(ri.resultKey, text)
            android.app.RemoteInput.addResultsToIntent(ris, intent, bundle)
            action.actionIntent.send(rc, 0, intent)
            rc.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit().putString("l_$key", text).apply()
            HelperLog.add(rc, "Replied in the chat")
            promise.resolve(true)
        } catch (e: Exception) {
            HelperLog.add(rc, "Chat reply failed: " + e.message)
            promise.resolve(false)
        }
    }

    // the phone's own theme colour (Material You), for tinting the glass
    @ReactMethod
    fun getAccent(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                val c = rc.resources.getColor(android.R.color.system_accent1_400, null)
                promise.resolve(String.format("#%06X", 0xFFFFFF and c))
                return
            }
        } catch (e: Exception) {
        }
        promise.resolve("")
    }

    @ReactMethod
    fun postNotice(title: String, text: String) {
        CallNotice.post(rc, title, text)
    }

    private fun saveBitmap(bmp: Bitmap, name: String): String? {
        return try {
            val f = java.io.File(rc.cacheDir, name)
            java.io.FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            f.absolutePath
        } catch (e: Exception) {
            null
        }
    }

    // waits a moment for the screenshot Android hands the assistant, then gives its file path
    @ReactMethod
    fun getScreenshotPath(promise: Promise) {
        Thread {
            var waited = 0
            while (PocketScreen.shot == null && waited < 3000) {
                Thread.sleep(100)
                waited += 100
            }
            val b = PocketScreen.shot
            promise.resolve(if (b == null) "" else (saveBitmap(b, "assist_shot.png") ?: ""))
        }.start()
    }

    @ReactMethod
    fun cropShot(fx: Double, fy: Double, fw: Double, fh: Double, promise: Promise) {
        try {
            val b = PocketScreen.shot
            if (b == null) {
                promise.resolve("")
                return
            }
            val x = (fx.coerceIn(0.0, 0.98) * b.width).toInt()
            val y = (fy.coerceIn(0.0, 0.98) * b.height).toInt()
            var w = (fw * b.width).toInt().coerceAtLeast(60)
            var h = (fh * b.height).toInt().coerceAtLeast(60)
            if (x + w > b.width) w = b.width - x
            if (y + h > b.height) h = b.height - y
            val c = Bitmap.createBitmap(b, x, y, w, h)
            promise.resolve(saveBitmap(c, "assist_crop.png") ?: "")
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    private fun toGallery(path: String, name: String): Uri? {
        if (Build.VERSION.SDK_INT < 29) return null
        val bmp = android.graphics.BitmapFactory.decodeFile(path) ?: return null
        val v = ContentValues()
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        v.put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/PocketPal")
        val uri = rc.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v) ?: return null
        rc.contentResolver.openOutputStream(uri)?.use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return uri
    }

    @ReactMethod
    fun saveImage(path: String, promise: Promise) {
        promise.resolve(toGallery(path, "pocketpal-" + System.currentTimeMillis() + ".png") != null)
    }

    // sends the picture to Google Lens (or any app you choose)
    @ReactMethod
    fun shareImage(path: String, pkg: String, promise: Promise) {
        val u = toGallery(path, "pocketpal-" + System.currentTimeMillis() + ".png")
        if (u == null) {
            promise.resolve(false)
            return
        }
        val i = Intent(Intent.ACTION_SEND)
        i.type = "image/png"
        i.putExtra(Intent.EXTRA_STREAM, u)
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (pkg.isNotBlank()) {
            i.setPackage(pkg)
            if (start(i)) {
                promise.resolve(true)
                return
            }
            i.setPackage(null)
        }
        promise.resolve(start(Intent.createChooser(i, "Search or share with")))
    }

    @ReactMethod
    fun takeScreenshotNow(promise: Promise) {
        val svc = AssistAccessibilityService.instance
        if (svc != null && Build.VERSION.SDK_INT >= 28) {
            rc.currentActivity?.finish()
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                try {
                    svc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT)
                } catch (e: Exception) {
                }
            }, 800)
            promise.resolve(true)
            return
        }
        val b = PocketScreen.shot
        if (b == null) {
            promise.resolve(false)
            return
        }
        val p = saveBitmap(b, "assist_full.png")
        promise.resolve(if (p != null) toGallery(p, "screenshot-" + System.currentTimeMillis() + ".png") != null else false)
    }

    // ------------------------------------------------------------ settings + call helper
    @ReactMethod
    fun getSettings(promise: Promise) {
        promise.resolve(rc.getSharedPreferences("assist_prefs", Context.MODE_PRIVATE).getString("json", "{}") ?: "{}")
    }

    @ReactMethod
    fun setSettings(json: String, promise: Promise) {
        rc.getSharedPreferences("assist_prefs", Context.MODE_PRIVATE).edit().putString("json", json).apply()
        promise.resolve(true)
    }

    @ReactMethod
    fun getHelperLog(promise: Promise) {
        promise.resolve(HelperLog.get(rc))
    }

    @ReactMethod
    fun clearHelperLog(promise: Promise) {
        HelperLog.clear(rc)
        promise.resolve(true)
    }

    @ReactMethod
    fun callHelperStatus(promise: Promise) {
        val sb = StringBuilder()
        sb.append("Helper running: ").append(if (CallHelperService.running) "yes" else "no").append("\n")
        sb.append(if (AssistNotificationService.instance != null) "OK  " else "OFF  ").append("Notification access (needed for RCS and WhatsApp replies)\n")
        sb.append(if (AssistAccessibilityService.instance != null) "OK  " else "OFF  ").append("Accessibility service (only for AI answering calls)\n")
        val names = linkedMapOf(
            Manifest.permission.READ_PHONE_STATE to "Phone state",
            Manifest.permission.ANSWER_PHONE_CALLS to "Decline calls",
            Manifest.permission.READ_CALL_LOG to "Call log (caller number)",
            Manifest.permission.SEND_SMS to "Send texts",
            Manifest.permission.RECEIVE_SMS to "Read replies",
            Manifest.permission.READ_CONTACTS to "Contacts (names)"
        )
        for ((perm, label) in names) {
            val g = ContextCompat.checkSelfPermission(rc, perm) == PackageManager.PERMISSION_GRANTED
            sb.append(if (g) "OK  " else "MISSING  ").append(label).append("\n")
        }
        try {
            val pm = rc.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            sb.append(if (pm.isIgnoringBatteryOptimizations(rc.packageName)) "OK  " else "RESTRICTED  ").append("Runs in the background without battery limits\n")
        } catch (e: Exception) {
        }
        promise.resolve(sb.toString())
    }

    @ReactMethod
    fun callHelperRunning(promise: Promise) {
        promise.resolve(CallHelperService.running)
    }

    @ReactMethod
    fun callHelper(on: Boolean, promise: Promise) {
        promise.resolve(callHelperImpl(on))
    }

    private fun callHelperImpl(on: Boolean): String {
        if (!on) {
            rc.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit().putBoolean("enabled", false).apply()
            rc.stopService(Intent(rc, CallHelperService::class.java))
            ok = true
            return "Call helper is off."
        }
        val perms = arrayListOf(
            Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG,
            Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_CONTACTS
        )
        if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
        val need = ArrayList<String>()
        for (p in perms) if (ContextCompat.checkSelfPermission(rc, p) != PackageManager.PERMISSION_GRANTED) need.add(p)
        if (need.isNotEmpty()) {
            val act = rc.currentActivity
            if (act != null) ActivityCompat.requestPermissions(act, need.toTypedArray(), 90)
            return "Please allow the permissions Android asks for, then turn the call helper on again. If Android blocks them, open PocketPal in app info, tap the three dots and allow restricted settings."
        }
        ContextCompat.startForegroundService(rc, Intent(rc, CallHelperService::class.java))
        ok = true
        val secs = AssistSettings.int(rc, "callSeconds", 20)
        return "Call helper is on. If you ignore a call for $secs seconds, I decline it, text the caller, and save who called and why in your notes."
    }

    @ReactMethod
    fun perform(action: String, argsJson: String, promise: Promise) {
        try {
            ok = false
            val a = JSONObject(argsJson)
            val res = when (action) {
                "open_app" -> openApp(a.optString("app"))
                "navigate" -> navigate(a.optString("to"))
                "alarm" -> alarm(a.optInt("h", 7), a.optInt("m", 0), a.optString("label", "PocketPal"))
                "timer" -> timer(a.optInt("seconds", 60))
                "call" -> call(a.optString("who"))
                "sms" -> sms(a.optString("who"), a.optString("text"))
                "flashlight" -> torch(a.optBoolean("on", true))
                "search" -> {
                    val q = a.optString("q")
                    if (start(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/search?q=" + Uri.encode(q))))) "Searching for $q" else "I could not open the browser."
                }
                "music" -> music(a.optString("q"))
                "settings" -> settingsPage(a.optString("page"))
                "volume" -> volume(a.optString("dir", "up"))
                "camera" -> if (start(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA))) "Opening the camera" else "I could not open the camera."
                "battery" -> {
                    val bm = rc.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
                    ok = true
                    "Battery is at " + bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) + " percent"
                }
                "email" -> email(a.optString("to"), a.optString("subject"), a.optString("body"))
                "callhelper" -> callHelperImpl(a.optBoolean("on", true))
                "open_url" -> {
                    val u = a.optString("url")
                    if (u.isBlank()) "There is no link to open." else if (start(Intent(Intent.ACTION_VIEW, Uri.parse(u)))) "Opening it" else "I could not open that link."
                }
                else -> "I can not do that yet."
            }
            val quiet = setOf("alarm", "timer", "flashlight", "volume", "battery", "callhelper")
            val kind = if (!ok) "ERR" else if (quiet.contains(action)) "DONE" else "OK"
            promise.resolve(kind + ":" + res)
        } catch (e: Exception) {
            promise.resolve("ERR:That did not work: " + (e.message ?: "unknown error"))
        }
    }
}
