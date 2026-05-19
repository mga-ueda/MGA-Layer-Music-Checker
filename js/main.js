const DISPLAY_ANALYSIS_FLOOR_DB = Object.freeze([-50, -60, -70, -80, -96]);

const DEFAULT_SPECTRUM_FLOOR_DB = -50;
const DEFAULT_METER_FLOOR_DB = -50;
const DEFAULT_FADE_TIME_SEC = 10;
const FADE_TIME_MIN_SEC = 1;
const FADE_TIME_MAX_SEC = 30;

function fadeTimeFallbackSec() {
    let d = Math.round(Number(DEFAULT_FADE_TIME_SEC));
    if (!Number.isFinite(d)) d = 10;
    return Math.min(FADE_TIME_MAX_SEC, Math.max(FADE_TIME_MIN_SEC, d));
}

function normalizeFadeTimeSeconds(raw) {
    const v = parseInt(String(raw ?? '').trim(), 10);
    if (!Number.isFinite(v) || v < FADE_TIME_MIN_SEC || v > FADE_TIME_MAX_SEC) {
        return fadeTimeFallbackSec();
    }
    return v;
}

const UI_PREFS_STORAGE_KEY = 'mga_layer_checker_ui_prefs_v1';

let spectrumDisplayDbMin = DISPLAY_ANALYSIS_FLOOR_DB.includes(DEFAULT_SPECTRUM_FLOOR_DB)
    ? DEFAULT_SPECTRUM_FLOOR_DB
    : -50;
let meterDisplayDbMin = DISPLAY_ANALYSIS_FLOOR_DB.includes(DEFAULT_METER_FLOOR_DB)
    ? DEFAULT_METER_FLOOR_DB
    : -50;

function saveUiPrefsToLocalStorage() {
    try {
        const fadeEl = document.getElementById('fadeTime');
        const fadeSec = fadeEl ? normalizeFadeTimeSeconds(fadeEl.value) : fadeTimeFallbackSec();
        if (fadeEl && fadeEl.value !== String(fadeSec)) fadeEl.value = String(fadeSec);
        localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
            spectrumFloor: spectrumDisplayDbMin,
            meterFloor: meterDisplayDbMin,
            fadeSec
        }));
    } catch (_) {}
}

(function syncInitialTransportAndMonitorControls() {
    try {
        const raw = localStorage.getItem(UI_PREFS_STORAGE_KEY);
        if (raw) {
            const o = JSON.parse(raw);
            if (o && typeof o === 'object') {
                if (typeof o.spectrumFloor === 'number' && DISPLAY_ANALYSIS_FLOOR_DB.includes(o.spectrumFloor)) {
                    spectrumDisplayDbMin = o.spectrumFloor;
                }
                if (typeof o.meterFloor === 'number' && DISPLAY_ANALYSIS_FLOOR_DB.includes(o.meterFloor)) {
                    meterDisplayDbMin = o.meterFloor;
                }
                if (o.fadeSec != null) {
                    const fs = parseInt(String(o.fadeSec), 10);
                    if (Number.isFinite(fs) && fs >= FADE_TIME_MIN_SEC && fs <= FADE_TIME_MAX_SEC) {
                        const fe = document.getElementById('fadeTime');
                        if (fe) fe.value = String(fs);
                    }
                }
            }
        }
    } catch (_) {}
    const fadeEl = document.getElementById('fadeTime');
    if (fadeEl) {
        const v = normalizeFadeTimeSeconds(fadeEl.value);
        fadeEl.value = String(v);
    }
    const specSel = document.getElementById('spectrumFloorDbSelect');
    const metSel = document.getElementById('meterFloorDbSelect');
    if (specSel) specSel.value = String(spectrumDisplayDbMin);
    if (metSel) metSel.value = String(meterDisplayDbMin);
})();

const logEl = document.getElementById('log');
function syncLogPanelHeightToShortcutGuide() {
    const guide = document.querySelector('.shortcut-guide');
    const log = document.getElementById('log');
    if (!guide || !log) return;
    const h = Math.max(120, Math.round(guide.getBoundingClientRect().height));
    log.style.height = `${h}px`;
    log.style.minHeight = `${h}px`;
    log.style.maxHeight = `${h}px`;
}
/* ログ表示の最大行数。超過分は古い行から削除して DOM 文字列が無制限に肥大するのを防ぐ。 */
const LOG_MAX_LINES = 500;
const writeLog = (m) => {
    const now = new Date();
    const time = `[${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}]`;
    const cur = logEl.innerText;
    const lines = cur ? cur.split('\n') : [];
    lines.push(`${time} - ${m}`);
    if (lines.length > LOG_MAX_LINES) {
        lines.splice(0, lines.length - LOG_MAX_LINES);
    }
    logEl.innerText = lines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
    syncLogPanelHeightToShortcutGuide();
};
(function initLogShortcutHeightSync() {
    const g = document.querySelector('.shortcut-guide');
    if (g && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => syncLogPanelHeightToShortcutGuide()).observe(g);
    }
    requestAnimationFrame(() => {
        syncLogPanelHeightToShortcutGuide();
        requestAnimationFrame(syncLogPanelHeightToShortcutGuide);
    });
})();

/**
 * マスター線形ゲイン g（スライダー値＝GainNode.gain）に対し、100%=1.0 を 0 dB とした振幅比
 * dB = 20·log10(g) の表示用文字列（ブースト時は先頭に +）。
 */
function formatMasterVolDisplayText(linearGain) {
    const g = Math.max(0, parseFloat(linearGain));
    const safeG = !isNaN(g) ? g : 0;
    const pct = Math.round(safeG * 100);
    if (safeG <= 0) return `${pct}% (−∞ dB)`;
    const db = 20 * Math.log10(safeG);
    const dbStr = db > 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
    return `${pct}% (${dbStr} dB)`;
}

let audioCtx = null;
let masterGain = null;
let masterAnalyser = null;
let anaL = null, anaR = null;

let clipTimers = {};
let gainReduceGlowTimer = null;
const METER_DB_MAX = 0;
const PEAK_HOLD_SEC = 1.0;
const PEAK_RELEASE_DB_PER_SEC = 10;
const METER_BAR_INST_TRACK = 0.48;
/** RMS ホールド線: 上方向だけ係数を弱くしてバーに食い込みにくくする EMA。 */
const RMS_HOLD_MARK_UP_SMOOTH = 0.010;
const RMS_HOLD_MARK_DN_SMOOTH = 0.034;

let meterChState = {
    l: {
        lastT: 0,
        visPeakDb: meterDisplayDbMin,
        visRmsDb: meterDisplayDbMin,
        peakHeldDb: meterDisplayDbMin,
        peakHoldUntil: -1e9,
        rmsHeldDb: meterDisplayDbMin,
        rmsHoldUntil: -1e9,
        rmsHoldLineDb: meterDisplayDbMin
    },
    r: {
        lastT: 0,
        visPeakDb: meterDisplayDbMin,
        visRmsDb: meterDisplayDbMin,
        peakHeldDb: meterDisplayDbMin,
        peakHoldUntil: -1e9,
        rmsHeldDb: meterDisplayDbMin,
        rmsHoldUntil: -1e9,
        rmsHoldLineDb: meterDisplayDbMin
    }
};
function resetMeterChState() {
    const z = () => ({
        lastT: 0,
        visPeakDb: meterDisplayDbMin,
        visRmsDb: meterDisplayDbMin,
        peakHeldDb: meterDisplayDbMin,
        peakHoldUntil: -1e9,
        rmsHeldDb: meterDisplayDbMin,
        rmsHoldUntil: -1e9,
        rmsHoldLineDb: meterDisplayDbMin
    });
    meterChState = { l: z(), r: z() };
}
let lastReductionTime = 0;
const REDUCTION_COOLDOWN = 450;

let tracks = [];
let sources = [];
let faderTimers = Array(4).fill(null);
/** 現在のフェード区間に適用している秒数（UI の設定は変えない）。上書き時はこの値の半分を切り上げたものを下限 1 秒で使う */
let faderFadeEffectiveSec = Array(4).fill(null);
let sessionRestoreInProgress = false;
let persistSessionTimer = null;
let isPlaying = false;
let startTimeInCtx = 0;
let pauseOffset = 0;
let shortestDuration = 0;
let requestAnimId = null;
let loopTimeout = null;
let spectrumBandEnv = null;
let spectrumPeakHoldDb = null;
let spectrumPeakHoldUntil = null;
let lastSpectrumDrawT = 0;
/* drawSpectrum: FFT/帯域/ぼかし用の再利用バッファ（長さは analyser / 帯本数に追随。中身は毎フレーム再計算） */
let spectrumScratchFloat = null;
let spectrumScratchFloatLen = 0;
let spectrumScratchTdL = null;
let spectrumScratchTdR = null;
let spectrumScratchTdLen = 0;
let spectrumScratchBandNb = 0;
let spectrumScratchBandDb = null;
let spectrumScratchBandLin = null;
let spectrumScratchDisplayDb = null;
let spectrumScratchBlurredLin = null;
const trackMeterByteBuf = new Uint8Array(128);
/** スペクトラム帯域グリッドの下限 Hz（ラベル・帯境界の基準） */
const SPECTRUM_GRID_FLOOR_HZ = 20;
const SPECTRUM_INSET_LEFT_PX = 12;
const SPECTRUM_INSET_RIGHT_PX = 4;
const SPECTRUM_BAR_GUTTER_PX = 1;
/**
 * 列方向ガウスぼかし（σ）と SPEC_SKIRT_* のバランスで山形が決まる。
 * 隣列だけ強めると単音で肩が平らになりやすいので、外周リングの倍率で調整する想定。
 */
const SPEC_BLUR_SIGMA = 0.45;
const SPEC_SKIRT_NEIGHBOR_ATTEN = 1.52;
const SPEC_SKIRT_OUTER_BOOST = 4.15;
const SPEC_SKIRT_RING3_MULT = 1.38;
const SPEC_SKIRT_RING4PLUS_MULT = 0.78;
const SPEC_SKIRT_MIN_PEAK_LIN = 1e-14;
const SPEC_SPECT_PEAK_HOLD_CENTER_SEC = 2.0;
const SPEC_PEAK_HOLD_NEIGHBOR_SEC = 0.38;
const SPEC_PEAK_HOLD_OUTER_SEC = 0.14;
const SPEC_PEAK_RELEASE_DB_PER_SEC = 5.25;
const SPEC_PEAK_RELEASE_MULT_NEIGHBOR = 1.22;
const SPEC_PEAK_RELEASE_MULT_OUTER = 1.55;
const SPEC_FFT_CAL_DB_MAX = 12;
const SPEC_BELL_CALIB_MIN_DOMINANCE_DB = 3;
const SPEC_SPECT_QP_RISE_SEC = 0.001;
const SPEC_SPECT_QP_FALL_SEC = 0.7;
const MONITOR_CHROME_FONT_PX = 8;

const canvas = document.getElementById('spectrumCanvas');
const canvasCtx = canvas.getContext('2d');

const mixerGrid = document.getElementById('mixer-grid');
mixerGrid.innerHTML = '';
for (let i = 0; i < 4; i++) {
    mixerGrid.innerHTML += `
        <div class="track-card" id="card-${i}">
            <span class="file-name" id="name-${i}">Slot ${i+1} - Empty</span>
            <div class="mixer-unit">
                <div class="meter-container"><div class="meter-bar" id="meter-${i}"></div></div>
                <div class="mixer-lane mixer-lane--fader">
                <input type="range" class="vol-slider" id="vol-${i}" min="0" max="1" step="0.001" value="0">
                </div>
                <div class="controls-column">
                    <div class="button-group">
                        <div class="group-label">Fade</div>
                        <div class="button-row">
                            <button type="button" id="fade-in-${i}" onclick="fadeTo(${i}, 1.0)" class="fade-in-btn">IN</button>
                            <button type="button" id="fade-out-${i}" onclick="fadeTo(${i}, 0.0)" class="fade-out-btn">OUT</button>
                        </div>
                    </div>
                    <div class="button-group">
                        <div class="group-label">Level</div>
                        <div class="button-row">
                            <button type="button" id="max-${i}" onclick="jumpTo(${i}, 1.0)" class="max-btn">MAX</button>
                            <button type="button" id="min-${i}" onclick="jumpTo(${i}, 0.0)" class="min-btn">MIN</button>
                        </div>
                    </div>
                    <div class="button-group">
                        <div class="group-label">Status</div>
                        <div class="button-row">
                            <button type="button" id="solo-${i}" onclick="toggleSolo(${i})" class="ms-btn" title="Solo" aria-label="Solo">S</button>
                            <button type="button" id="mute-${i}" onclick="toggleMute(${i})" class="ms-btn" title="Mute" aria-label="Mute">M</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
}

const FADER_AT_END_EPS = 1e-5;

function isFaderAtMax(i) {
    const el = document.getElementById(`vol-${i}`);
    if (!el) return false;
    return parseFloat(el.value) >= 1 - FADER_AT_END_EPS;
}
function isFaderAtMin(i) {
    const el = document.getElementById(`vol-${i}`);
    if (!el) return false;
    return parseFloat(el.value) <= 0 + FADER_AT_END_EPS;
}

function updateFaderButtonsForSlot(i) {
    const fadeIn = document.getElementById(`fade-in-${i}`);
    const fadeOut = document.getElementById(`fade-out-${i}`);
    const maxB = document.getElementById(`max-${i}`);
    const minB = document.getElementById(`min-${i}`);
    const solo = document.getElementById(`solo-${i}`);
    const mute = document.getElementById(`mute-${i}`);
    const volEl = document.getElementById(`vol-${i}`);
    if (!fadeIn || !fadeOut || !maxB || !minB || !solo || !mute || !volEl) return;

    if (!tracks[i]) {
        volEl.disabled = true;
        fadeIn.disabled = true;
        fadeOut.disabled = true;
        maxB.disabled = true;
        minB.disabled = true;
        solo.disabled = true;
        mute.disabled = true;
        return;
    }

    volEl.disabled = false;
    solo.disabled = false;
    mute.disabled = false;

    const hi = isFaderAtMax(i);
    const lo = isFaderAtMin(i);
    fadeIn.disabled = hi;
    maxB.disabled = hi;
    fadeOut.disabled = lo;
    minB.disabled = lo;

    const card = document.getElementById(`card-${i}`);
    if (card) {
        if (tracks[i]) {
            const raw = parseFloat(document.getElementById(`vol-${i}`).value);
            const g = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0));
            card.style.setProperty('--fader-glow', String(g));
        } else {
            card.style.removeProperty('--fader-glow');
        }
    }
}

function updateAllFaderButtons() {
    for (let i = 0; i < 4; i++) updateFaderButtonsForSlot(i);
}

updateAllFaderButtons();
syncTransportButton();

const IDB_NAME = 'mga_layer_checker_audio_v1';
const IDB_STORE = 'sessions';
const IDB_KEY_LAST = 'lastSession';

function idbOpen() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) {
                req.result.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSaveLastSessionSlots(slotsArr) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(IDB_STORE).put({ slots: slotsArr }, IDB_KEY_LAST);
    });
}

async function idbLoadLastSessionSlots() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get(IDB_KEY_LAST);
        r.onsuccess = () => {
            const v = r.result;
            resolve(v && Array.isArray(v.slots) ? v.slots : null);
        };
        r.onerror = () => reject(r.error);
    });
}

async function persistLastSessionToIDB() {
    const slots = [];
    for (let i = 0; i < 4; i++) {
        const t = tracks[i];
        if (t && t.rawBuffer && t.fileName && t.rawBuffer.byteLength) {
            try {
                const volRaw = parseFloat(document.getElementById(`vol-${i}`).value);
                const vol = Number.isFinite(volRaw) ? Math.max(0, Math.min(1, volRaw)) : 0;
                slots.push({
                    fileName: t.fileName,
                    raw: t.rawBuffer.slice(0),
                    vol,
                    isMute: !!t.isMute,
                    isSolo: !!t.isSolo
                });
            } catch (_) {
                slots.push(null);
            }
        } else {
            slots.push(null);
        }
    }
    try {
        await idbSaveLastSessionSlots(slots);
    } catch (e) {
        writeLog(`Session save failed: ${e && e.message ? e.message : 'error'}.`);
    }
}

function schedulePersistSession() {
    if (sessionRestoreInProgress) return;
    if (!tracks.some((t) => t)) return;
    if (persistSessionTimer) clearTimeout(persistSessionTimer);
    persistSessionTimer = setTimeout(() => {
        persistSessionTimer = null;
        persistLastSessionToIDB();
    }, 500);
}

/* 旧スロットの GainNode/AnalyserNode を音声グラフから切り離す（AudioContext 内部に滞留させない）。 */
function disposeSlotAudioNodes(t) {
    if (!t) return;
    try { if (t.gainNode) t.gainNode.disconnect(); } catch (_) {}
    try { if (t.analyser) t.analyser.disconnect(); } catch (_) {}
}

function mountDecodedTrackAtSlot(i, buffer, fileName, rawBuffer) {
    disposeSlotAudioNodes(tracks[i]);
    const g = audioCtx.createGain();
    const ana = audioCtx.createAnalyser();
    ana.fftSize = 256;
    g.connect(ana);
    ana.connect(masterGain);
    g.gain.setValueAtTime(getPracticalGain(0.0), audioCtx.currentTime);
    const rawStored = rawBuffer && rawBuffer.byteLength ? rawBuffer.slice(0) : null;
    tracks[i] = { buffer, gainNode: g, analyser: ana, isMute: false, isSolo: false, fileName, rawBuffer: rawStored };
    document.getElementById(`name-${i}`).innerText = fileName;
    document.getElementById(`card-${i}`).classList.add('loaded');
}

function clearSlotMixerState(i) {
    disposeSlotAudioNodes(tracks[i]);
    delete tracks[i];
    document.getElementById(`name-${i}`).innerText = `[Slot ${i+1}] Empty`;
    document.getElementById(`card-${i}`).classList.remove('loaded');
    document.getElementById(`card-${i}`).style.removeProperty('--fader-glow');
    document.getElementById(`vol-${i}`).value = 0.0;
    document.getElementById(`meter-${i}`).style.height = '0%';
    document.getElementById(`mute-${i}`).classList.remove('mute-on');
    document.getElementById(`solo-${i}`).classList.remove('solo-on');
}

function applyPersistedMixToSlot(i, rec) {
    const t = tracks[i];
    if (!t) return;
    let vol;
    if (rec && typeof rec.vol === 'number' && Number.isFinite(rec.vol)) {
        vol = Math.max(0, Math.min(1, rec.vol));
    } else {
        vol = i === 0 ? 1.0 : 0.0;
    }
    document.getElementById(`vol-${i}`).value = vol;
    const mute = rec && !!rec.isMute;
    const solo = rec && !!rec.isSolo;
    t.isMute = mute;
    t.isSolo = solo;
    document.getElementById(`mute-${i}`).classList.toggle('mute-on', mute);
    document.getElementById(`solo-${i}`).classList.toggle('solo-on', solo);
}

async function restoreSessionFromIndexedDB(opts) {
    const startup = !!(opts && opts.startup);
    sessionRestoreInProgress = true;
    try {
        let slots = null;
        try {
            slots = await idbLoadLastSessionSlots();
        } catch (e) {
            if (!startup) writeLog(`Last session: storage read failed (${e && e.message ? e.message : 'error'}).`);
            return false;
        }
        if (!slots) {
            if (!startup) writeLog('Last session: nothing stored.');
            return false;
        }
        initAudio();
        for (let i = 0; i < 4; i++) {
            const slot = slots[i];
            if (!slot || !slot.fileName || !slot.raw || !(slot.raw instanceof ArrayBuffer) || slot.raw.byteLength === 0) {
                clearSlotMixerState(i);
                continue;
            }
            try {
                const arr = slot.raw.slice(0);
                const buffer = await audioCtx.decodeAudioData(arr);
                mountDecodedTrackAtSlot(i, buffer, slot.fileName, slot.raw);
                applyPersistedMixToSlot(i, slot);
                if (!startup) writeLog(`Slot ${i+1} restored: ${slot.fileName}`);
            } catch (e) {
                writeLog(`Last session: "${slot.fileName}" could not be restored (${e && e.message ? e.message : 'decode error'}).`);
                clearSlotMixerState(i);
            }
        }
        if (!tracks.some((t) => t)) {
            if (!startup) writeLog('Last session: no tracks could be restored.');
            return false;
        }
        updateAllFaderButtons();
        shortestDuration = Math.min(...tracks.filter((t) => t).map((t) => t.buffer.duration));
        document.getElementById('totalTime').innerText = formatTime(shortestDuration);
        const seek = document.getElementById('seekBar');
        if (seek) seek.value = 0;
        const curEl = document.getElementById('currentTime');
        if (curEl) curEl.innerText = formatTime(0);
        updateMix();
        syncTransportButton();
        if (startup) writeLog('Last session: tracks loaded (stopped).');
        return true;
    } finally {
        sessionRestoreInProgress = false;
    }
}

for (let i = 0; i < 4; i++) {
    document.getElementById(`vol-${i}`).oninput = () => {
        if (tracks[i] && audioCtx) {
            cancelFaderTimer(i);
            faderFadeEffectiveSec[i] = null;
            tracks[i].gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
        }
        updateMix();
    };
}

const initAudio = () => {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = parseFloat(document.getElementById('masterVolSlider').value); 
        
        masterAnalyser = audioCtx.createAnalyser();
        /* スペクトラム用 analyser: fftSize=帯域ビン幅、smoothing=ビン間 EMA（drawSpectrum より前段） */
        masterAnalyser.fftSize = 2048;
        masterAnalyser.smoothingTimeConstant = 0.14;
        masterAnalyser.minDecibels = -100;
        masterAnalyser.maxDecibels = 0;

        const splitter = audioCtx.createChannelSplitter(2);
        anaL = audioCtx.createAnalyser();
        anaR = audioCtx.createAnalyser();
        anaL.fftSize = 1024; 
        anaR.fftSize = 1024;
        anaL.smoothingTimeConstant = 0.62;
        anaR.smoothingTimeConstant = 0.62;

        masterGain.connect(masterAnalyser);
        masterGain.connect(splitter);
        splitter.connect(anaL, 0);
        splitter.connect(anaR, 1);
        masterGain.connect(audioCtx.destination);

        document.getElementById('masterVolSlider').oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
                masterGain.gain.setTargetAtTime(val, audioCtx.currentTime, 0.05);
                document.getElementById('masterVolDisp').innerText = formatMasterVolDisplayText(val);
            }
        };
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (!requestAnimId) requestAnimationFrame(() => paintSpectrumIdle());
};

function getPracticalGain(value) { return value <= 0 ? 0 : Math.pow(value, 1.5); }

function syncTransportButton() {
    const btn = document.getElementById('playStopBtn');
    const seekWrap = document.getElementById('seekBarWrap');
    if (seekWrap) seekWrap.classList.toggle('seek-bar-wrap--playing', isPlaying);
    if (!btn) return;
    btn.classList.toggle('transport-toggle--stop', isPlaying);
    btn.disabled = false;
    btn.textContent = isPlaying ? 'STOP' : 'PLAY SYNC';
}

function resetAllStates() {
    isPlaying = false;
    stopSources();
    if (requestAnimId) { cancelAnimationFrame(requestAnimId); requestAnimId = null; }
    tracks.forEach((t) => disposeSlotAudioNodes(t));
    tracks = []; pauseOffset = 0; startTimeInCtx = 0; shortestDuration = 0;
    spectrumBandEnv = null;
    spectrumPeakHoldDb = null;
    spectrumPeakHoldUntil = null;
    lastSpectrumDrawT = 0;
    document.querySelectorAll('.clip-lamp').forEach(l => {
        l.classList.remove('clip-on');
        if(clipTimers[l.id]) clearTimeout(clipTimers[l.id]);
    });
    const mvWrapReset = document.querySelector('.master-vol-container');
    if (mvWrapReset) mvWrapReset.classList.remove('gain-reduce-glow');
    if (gainReduceGlowTimer) { clearTimeout(gainReduceGlowTimer); gainReduceGlowTimer = null; }

    const mvSlider = document.getElementById('masterVolSlider');
    mvSlider.value = 1.0;
    document.getElementById('masterVolDisp').innerText = formatMasterVolDisplayText(1.0);
    if (masterGain) {
        masterGain.gain.setTargetAtTime(1.0, audioCtx ? audioCtx.currentTime : 0, 0.01);
    }

    faderFadeEffectiveSec = Array(4).fill(null);
    for (let i = 0; i < 4; i++) {
        cancelFaderTimer(i);
        document.getElementById(`name-${i}`).innerText = `[Slot ${i+1}] Empty`;
        document.getElementById(`card-${i}`).classList.remove('loaded');
        document.getElementById(`card-${i}`).style.removeProperty('--fader-glow');
        document.getElementById(`vol-${i}`).value = 0.0;
        document.getElementById(`meter-${i}`).style.height = '0%';
        document.getElementById(`mute-${i}`).classList.remove('mute-on');
        document.getElementById(`solo-${i}`).classList.remove('solo-on');
    }
    resetMeterChState();
    extinguishMonitorDisplays();
    syncTransportButton();
    updateAllFaderButtons();
}

const ALLOWED_AUDIO_EXTENSIONS = ['.wav', '.wave', '.mp3', '.aif', '.aiff'];
function isAllowedAudioFile(file) {
    const n = file.name.toLowerCase();
    return ALLOWED_AUDIO_EXTENSIONS.some((ext) => n.endsWith(ext));
}

document.getElementById('main-drop-zone').ondragover = (e) => e.preventDefault();
document.getElementById('main-drop-zone').ondrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(isAllowedAudioFile)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
    if (files.length === 0) {
        writeLog('No supported audio files (WAV / Wave / MP3 / AIF / AIFF).');
        return;
    }
    initAudio();
    resetAllStates();
    writeLog(`Loading ${files.length} files...`);
    if (files.length > 4) {
        const ignored = files.slice(4).map((f) => f.name).join(', ');
        writeLog(`Note: ${files.length - 4} extra file(s) ignored (max 4 slots): ${ignored}`);
    }

    for (let i = 0; i < Math.min(files.length, 4); i++) {
        try {
            const arrayBuffer = await files[i].arrayBuffer();
            const rawCopy = arrayBuffer.slice(0);
            const buffer = await audioCtx.decodeAudioData(arrayBuffer);
            mountDecodedTrackAtSlot(i, buffer, files[i].name, rawCopy);
            writeLog(`Slot ${i+1} loaded: ${files[i].name}`);
        } catch (err) { writeLog(`Error Slot ${i+1}: ${err.message}`); }
    }
    updateAllFaderButtons();
    if (tracks[0]) {
        document.getElementById('vol-0').value = 1.0;
        updateMix();
    }
    if (tracks.some((t) => t)) {
        await persistLastSessionToIDB();
        shortestDuration = Math.min(...tracks.filter(t => t).map(t => t.buffer.duration));
        document.getElementById('totalTime').innerText = formatTime(shortestDuration);
        writeLog("All tracks ready.");
        writeLog("Transport: Auto-play");
        await startTransportFromStart();
    }
};

const formatTime = (sec) => {
    if (isNaN(sec) || sec < 0) return "00:00";
    const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
};

const METER_KNEE_DB = -20;
const METER_LO_SEGMENT_FRAC = 0.4;

const meterDbToNorm = (db) => {
    if (!isFinite(db)) return 0;
    const lo = meterDisplayDbMin;
    const c = Math.max(lo, Math.min(METER_DB_MAX, db));
    if (c <= METER_KNEE_DB) {
        return ((c - lo) / (METER_KNEE_DB - lo)) * METER_LO_SEGMENT_FRAC;
    }
    return METER_LO_SEGMENT_FRAC + ((c - METER_KNEE_DB) / (METER_DB_MAX - METER_KNEE_DB)) * (1 - METER_LO_SEGMENT_FRAC);
};

const meterDbToHeightPct = (db) => meterDbToNorm(db) * 100;

/** メーターとスペクトラム列で共有する段階 RGB（t は meterDbToNorm 等の 0〜1）。 */
function meterLevelColorLerp(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [
        { p: 0, r: 2, g: 24, b: 32 },
        { p: 0.26, r: 13, g: 74, b: 98 },
        { p: 0.55, r: 58, g: 184, b: 232 },
        { p: 0.82, r: 200, g: 239, b: 255 },
        { p: 1, r: 248, g: 254, b: 255 },
    ];
    let i = 0;
    for (; i < stops.length - 2; i++) {
        if (t <= stops[i + 1].p) break;
    }
    const a = stops[i];
    const b = stops[i + 1];
    const denom = b.p - a.p;
    const w = denom < 1e-9 ? 1 : (t - a.p) / denom;
    const r = Math.round(a.r + (b.r - a.r) * w);
    const g = Math.round(a.g + (b.g - a.g) * w);
    const bl = Math.round(a.b + (b.b - a.b) * w);
    return `rgb(${r},${g},${bl})`;
}

const METER_GRAD_DEEP = '#021820';
const METER_GRAD_MID = '#0d4a62';
const METER_GRAD_LIT = '#3ab8e8';
const METER_GRAD_PALE = '#c8efff';
const METER_GRAD_WHITE = '#f8feff';

function masterMeterBarBackgroundImage() {
    return (
        `linear-gradient(to top, ${METER_GRAD_DEEP} 0%, ${METER_GRAD_MID} 26%, ` +
        `${METER_GRAD_LIT} 55%, ${METER_GRAD_PALE} 82%, ${METER_GRAD_WHITE} 100%)`
    );
}

/** メーターバー 4 本に同一グラデを貼り、見かけの高さは要素の height% のみで変える。 */
function syncMasterMeterBarBackgroundStyles(pxHeight) {
    const img = masterMeterBarBackgroundImage();
    const h = Math.max(48, pxHeight | 0);
    for (const id of ['m-peak-l', 'm-rms-l', 'm-peak-r', 'm-rms-r']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.style.backgroundImage = img;
        el.style.backgroundSize = `100% ${h}px`;
        el.style.backgroundPosition = 'center bottom';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundColor = 'transparent';
    }
}

function masterMeterLineColorForDb(db) {
    if (!isFinite(db)) return meterLevelColorLerp(0);
    return meterLevelColorLerp(meterDbToNorm(db));
}

function masterMeterHoldBorderColorForDb(db) {
    return '#000000';
}

const formatMeterDbReadout = (db) => {
    if (!isFinite(db) || db <= meterDisplayDbMin) return `${meterDisplayDbMin}.0`;
    return Math.min(METER_DB_MAX, db).toFixed(1);
};

function meterScaleLabelListForFloor(floorDb) {
    const base = [0, -5, -10, -15, -20];
    const seen = new Set(base);
    const tail = [];
    for (let d = -30; d > floorDb; d -= 10) {
        if (!seen.has(d)) {
            tail.push(d);
            seen.add(d);
        }
    }
    if (!seen.has(floorDb)) tail.push(floorDb);
    return [...base, ...tail];
}

function buildMasterMeterTickBackground() {
    const layers = [];
    const usedY = new Set();
    for (const d of meterScaleLabelListForFloor(meterDisplayDbMin)) {
        const y = (1 - meterDbToNorm(d)) * 100;
        const yKey = Math.round(y * 1e4) / 1e4;
        if (usedY.has(yKey)) continue;
        usedY.add(yKey);
        const col = 'rgba(255, 255, 255, 0.22)';
        const half = 0.16;
        const t1 = Math.max(0, y - half);
        const t2 = Math.min(100, y + half);
        layers.push(`linear-gradient(to bottom, transparent ${t1}%, ${col} ${t1}%, ${col} ${t2}%, transparent ${t2}%)`);
    }
    return layers.join(', ');
}

function installMasterMeterScaleUI() {
    const floor = meterDisplayDbMin;
    const mkSpan = (db) => {
        const span = document.createElement('span');
        span.textContent = db === 0 ? '0' : String(db);
        if (db === floor) {
            span.style.top = '100%';
            span.style.transform = 'translateY(-100%)';
        } else if (db === METER_DB_MAX) {
            span.style.top = '0%';
            span.style.transform = 'translateY(calc(-50% + 3px))';
        } else {
            const pct = (1 - meterDbToNorm(db)) * 100;
            span.style.top = `${Math.round(pct * 1000) / 1000}%`;
            span.style.transform = 'translateY(calc(-50% + 3px))';
        }
        return span;
    };
    const left = document.getElementById('m-scale-labels-left');
    const right = document.getElementById('m-scale-labels-right');
    if (!left || !right) return;
    left.textContent = '';
    right.textContent = '';
    for (const db of meterScaleLabelListForFloor(floor)) {
        left.appendChild(mkSpan(db));
        right.appendChild(mkSpan(db));
    }
    const bg = buildMasterMeterTickBackground();
    document.querySelectorAll('.m-meter-ticks').forEach((el) => {
        el.style.backgroundImage = bg;
    });
    syncMonitorAnalysisLayoutHeights();
}

function bindMonitorFloorControls() {
    const specSel = document.getElementById('spectrumFloorDbSelect');
    const metSel = document.getElementById('meterFloorDbSelect');
    if (!specSel || !metSel) return;
    specSel.value = String(spectrumDisplayDbMin);
    metSel.value = String(meterDisplayDbMin);
    specSel.addEventListener('change', () => {
        const v = parseInt(specSel.value, 10);
        if (!Number.isFinite(v) || !DISPLAY_ANALYSIS_FLOOR_DB.includes(v)) return;
        spectrumDisplayDbMin = v;
        spectrumBandEnv = null;
        spectrumPeakHoldDb = null;
        spectrumPeakHoldUntil = null;
        lastSpectrumDrawT = 0;
        if (!requestAnimId) paintSpectrumIdle();
        writeLog(`Spectrum display floor: ${v} dB`);
        saveUiPrefsToLocalStorage();
    });
    metSel.addEventListener('change', () => {
        const v = parseInt(metSel.value, 10);
        if (!Number.isFinite(v) || !DISPLAY_ANALYSIS_FLOOR_DB.includes(v)) return;
        meterDisplayDbMin = v;
        installMasterMeterScaleUI();
        resetMeterChState();
        if (!requestAnimId) extinguishMonitorDisplays();
        writeLog(`Level meter floor: ${v} dB`);
        saveUiPrefsToLocalStorage();
    });
}
bindMonitorFloorControls();

(function bindAppDocFoldAccordion() {
    const folds = document.querySelectorAll('details.app-doc-fold');
    if (!folds.length) return;
    folds.forEach((d) => {
        d.addEventListener('toggle', () => {
            if (!d.open) return;
            folds.forEach((other) => {
                if (other !== d) other.removeAttribute('open');
            });
        });
    });
})();

(function bindFadeTimeControl() {
    const el = document.getElementById('fadeTime');
    if (!el) return;
    el.addEventListener('input', () => {
        const t = el.value.replace(/\D/g, '').slice(0, 2);
        if (el.value !== t) el.value = t;
    });
    const commit = () => {
        const v = normalizeFadeTimeSeconds(el.value);
        el.value = String(v);
        saveUiPrefsToLocalStorage();
    };
    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
})();

requestAnimationFrame(() => paintSpectrumIdle());
window.addEventListener('resize', () => {
    if (!requestAnimId) paintSpectrumIdle();
    else syncMonitorAnalysisLayoutHeights();
    syncLogPanelHeightToShortcutGuide();
});

const getMeterValues = (analyser, side, ctxNow) => {
    const empty = () => ({
        pPct: 0,
        rPct: 0,
        peakHoldBottomPct: 0,
        rmsHoldBottomPct: 0,
        peakDb: meterDisplayDbMin,
        peakHeldDb: meterDisplayDbMin,
        instPeakDb: meterDisplayDbMin,
        rmsDb: meterDisplayDbMin,
        rmsHeldDb: meterDisplayDbMin,
        instRmsDb: meterDisplayDbMin,
        rmsDbDisp: meterDisplayDbMin,
        rawPeak: 0,
        showPeakHoldLine: false,
        showRmsHoldLine: false,
        peakHoldLineColor: meterLevelColorLerp(0),
        rmsHoldLineColor: meterLevelColorLerp(0),
        peakHoldBorderColor: masterMeterHoldBorderColorForDb(meterDisplayDbMin),
        rmsHoldBorderColor: masterMeterHoldBorderColorForDb(meterDisplayDbMin)
    });
    if (!analyser || !audioCtx) return empty();

    const st = meterChState[side];
    const dt = st.lastT > 0 ? Math.min(0.12, Math.max(0, ctxNow - st.lastT)) : (1 / 60);
    st.lastT = ctxNow;

    const bufferLength = analyser.fftSize;
    const timeData = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(timeData);
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < bufferLength; i++) {
        const val = Math.abs(timeData[i]);
        if (val > peak) peak = val;
        sumSquares += val * val;
    }
    const rms = Math.sqrt(sumSquares / bufferLength);

    const instPeakDb = 20 * Math.log10(Math.max(peak, 1e-8));
    const instRmsDb = 20 * Math.log10(Math.max(rms, 1e-8));

    st.visPeakDb += (instPeakDb - st.visPeakDb) * METER_BAR_INST_TRACK;
    st.visRmsDb += (instRmsDb - st.visRmsDb) * METER_BAR_INST_TRACK;
    st.visPeakDb = Math.max(meterDisplayDbMin, Math.min(METER_DB_MAX, st.visPeakDb));
    st.visRmsDb = Math.max(meterDisplayDbMin, Math.min(METER_DB_MAX, st.visRmsDb));

    let peakHeldDb = st.peakHeldDb;
    if (instPeakDb > peakHeldDb) {
        peakHeldDb = instPeakDb;
        st.peakHoldUntil = ctxNow + PEAK_HOLD_SEC;
    } else if (ctxNow >= st.peakHoldUntil) {
        peakHeldDb = Math.max(instPeakDb, peakHeldDb - PEAK_RELEASE_DB_PER_SEC * dt);
    }
    peakHeldDb = Math.max(meterDisplayDbMin, Math.min(METER_DB_MAX, peakHeldDb));
    st.peakHeldDb = peakHeldDb;

    let rmsHeldDb = st.rmsHeldDb;
    if (instRmsDb > rmsHeldDb) {
        rmsHeldDb = instRmsDb;
        st.rmsHoldUntil = ctxNow + PEAK_HOLD_SEC;
    } else if (ctxNow >= st.rmsHoldUntil) {
        rmsHeldDb = Math.max(instRmsDb, rmsHeldDb - PEAK_RELEASE_DB_PER_SEC * dt);
    }
    rmsHeldDb = Math.max(meterDisplayDbMin, Math.min(METER_DB_MAX, rmsHeldDb));
    st.rmsHeldDb = rmsHeldDb;

    const tgt = rmsHeldDb;
    let lineDb = st.rmsHoldLineDb;
    if (!isFinite(lineDb)) lineDb = tgt;
    const k = tgt > lineDb + 1e-6 ? RMS_HOLD_MARK_UP_SMOOTH : RMS_HOLD_MARK_DN_SMOOTH;
    lineDb += (tgt - lineDb) * k;
    st.rmsHoldLineDb = Math.max(meterDisplayDbMin, Math.min(METER_DB_MAX, lineDb));

    const pInstPct = meterDbToHeightPct(st.visPeakDb);
    const rInstPct = meterDbToHeightPct(st.visRmsDb);

    return {
        pPct: pInstPct,
        rPct: rInstPct,
        peakHoldBottomPct: meterDbToHeightPct(peakHeldDb),
        rmsHoldBottomPct: meterDbToHeightPct(st.rmsHoldLineDb),
        peakDb: peakHeldDb,
        peakHeldDb,
        instPeakDb,
        rmsDb: instRmsDb,
        rmsHeldDb,
        instRmsDb,
        rmsDbDisp: rmsHeldDb,
        rawPeak: peak,
        showPeakHoldLine: peakHeldDb > instPeakDb + 0.05,
        showRmsHoldLine: rmsHeldDb > instRmsDb + 0.05,
        peakHoldLineColor: masterMeterLineColorForDb(peakHeldDb),
        rmsHoldLineColor: masterMeterLineColorForDb(st.rmsHoldLineDb),
        peakHoldBorderColor: masterMeterHoldBorderColorForDb(peakHeldDb),
        rmsHoldBorderColor: masterMeterHoldBorderColorForDb(st.rmsHoldLineDb)
    };
};

const triggerGainReduceGlow = () => {
    const mvWrap = document.querySelector('.master-vol-container');
    if (!mvWrap) return;
    mvWrap.classList.remove('gain-reduce-glow');
    void mvWrap.offsetWidth;
    mvWrap.classList.add('gain-reduce-glow');
    if (gainReduceGlowTimer) clearTimeout(gainReduceGlowTimer);
    gainReduceGlowTimer = setTimeout(() => {
        mvWrap.classList.remove('gain-reduce-glow');
        gainReduceGlowTimer = null;
    }, 1000);
};

const autoReduceGain = (excessDb) => {
    const now = Date.now();
    if (!isPlaying || excessDb < 0.2 || isNaN(excessDb) || (now - lastReductionTime < REDUCTION_COOLDOWN)) return;
    const mvSlider = document.getElementById('masterVolSlider');
    const currentGain = parseFloat(mvSlider.value);
    const reductionFactor = Math.max(0.93, Math.pow(10, -excessDb / 48));
    const newGain = Math.max(0.01, currentGain * reductionFactor);
    const didReduce = newGain < currentGain - 0.0005;
    lastReductionTime = now;
    mvSlider.value = newGain.toFixed(2);
    masterGain.gain.setTargetAtTime(newGain, audioCtx.currentTime, 0.05);
    document.getElementById('masterVolDisp').innerText = formatMasterVolDisplayText(newGain);
    writeLog(`! CLIP PROTECT: -${excessDb.toFixed(1)}dB reduction.`);
    if (didReduce) triggerGainReduceGlow();
};

const triggerClipLamp = (id) => {
    const lamp = document.getElementById(id);
    if (!lamp) return;
    lamp.classList.add('clip-on');
    if (clipTimers[id]) clearTimeout(clipTimers[id]);
    clipTimers[id] = setTimeout(() => {
        lamp.classList.remove('clip-on');
    }, 2000); 
};

const updateUIFrame = () => {
    if (!isPlaying) return;
    const ctxNow = audioCtx.currentTime;
    const transportT = (ctxNow - startTimeInCtx + pauseOffset) % shortestDuration;
    document.getElementById('seekBar').value = (transportT / shortestDuration) * 100;
    document.getElementById('currentTime').innerText = formatTime(transportT);

    const l = getMeterValues(anaL, 'l', ctxNow);
    const r = getMeterValues(anaR, 'r', ctxNow);

    const maxPeakDb = Math.max(l.instPeakDb, r.instPeakDb);
    if (isFinite(maxPeakDb) && maxPeakDb > 0.15) {
        autoReduceGain(maxPeakDb);
    }

    const mCont0 = document.querySelector('.m-meter-container');
    const meterStackH = mCont0 && mCont0.clientHeight > 8 ? mCont0.clientHeight : defaultSpectrumLedTrackHeightPx();
    const meterHoldHpx = meterStackH / Math.abs(METER_DB_MAX - meterDisplayDbMin);
    syncMasterMeterBarBackgroundStyles(meterStackH);

    const applyM = (s, d) => {
        const elPk = document.getElementById(`m-peak-${s}`);
        elPk.style.height = d.pPct + '%';
        const elRms = document.getElementById(`m-rms-${s}`);
        elRms.style.height = d.rPct + '%';
        const phl = document.getElementById(`m-peak-${s}-hold`);
        if (phl) {
            phl.style.height = `${meterHoldHpx}px`;
            phl.style.bottom = d.peakHoldBottomPct + '%';
            phl.style.opacity = d.showPeakHoldLine ? '1' : '0';
            phl.style.background = d.peakHoldLineColor;
            phl.style.borderColor = d.peakHoldBorderColor;
        }
        const rhl = document.getElementById(`m-rms-${s}-hold`);
        if (rhl) {
            rhl.style.height = `${meterHoldHpx}px`;
            rhl.style.bottom = d.rmsHoldBottomPct + '%';
            rhl.style.opacity = d.showRmsHoldLine ? '1' : '0';
            rhl.style.background = d.rmsHoldLineColor;
            rhl.style.borderColor = d.rmsHoldBorderColor;
        }
        document.getElementById(`val-peak-${s}`).innerText = formatMeterDbReadout(d.peakDb);
        document.getElementById(`val-rms-${s}`).innerText = formatMeterDbReadout(d.rmsDbDisp);

        if (d.instPeakDb >= 0) triggerClipLamp(`clip-peak-${s}`);
        document.getElementById(`val-peak-${s}`).style.color = '#ffffff';
        document.getElementById(`val-rms-${s}`).style.color = '#ffffff';
    };
    applyM('l', l); applyM('r', r);
    
    const anySolo = tracks.some((tr) => tr && tr.isSolo);
    tracks.forEach((t, i) => {
        if (t) {
            t.analyser.getByteFrequencyData(trackMeterByteBuf);
            let max = 0;
            for (let j = 0; j < trackMeterByteBuf.length; j++) {
                if (trackMeterByteBuf[j] > max) max = trackMeterByteBuf[j];
            }
            const isSilent = t.isMute || (anySolo && !t.isSolo);
            document.getElementById(`meter-${i}`).style.height = isSilent ? '0%' : (max / 255 * 100) + '%';
        }
    });

    drawSpectrum();
    requestAnimId = requestAnimationFrame(updateUIFrame);
};

const SPECTRUM_DB_MAX = 0;
const SPEC_DISPLAY_PEAK_SOFT_KNEE_DB = -6;
const SPEC_DISPLAY_PEAK_SOFT_GAMMA = 1.24;
const SPEC_LED_DIM_GREEN = '#13181e';
const SPEC_GRID_BLACK = '#000000';
const SPEC_LED_CELL_HEIGHT_PX = 5;
const SPEC_LED_HLINE_PX = 1;
const SPEC_PAD_TOP_PX = 14;
const SPEC_FREQ_LABELS_BELOW_PX = 40;

function spectrumDbNormLinear(db) {
    if (!isFinite(db)) return 0;
    const lo = spectrumDisplayDbMin;
    const hi = SPECTRUM_DB_MAX;
    const range = hi - lo;
    if (range <= 0) return 0;
    const c = Math.max(lo, Math.min(hi, db));
    return (c - lo) / range;
}

/** 膝より上だけ γ>1 で圧縮（0 dB は維持）。 */
function spectrumDisplayPeakSoften(db) {
    if (!isFinite(db)) return spectrumDisplayDbMin;
    const hi = SPECTRUM_DB_MAX;
    const x = Math.max(spectrumDisplayDbMin, Math.min(hi, db));
    const knee = SPEC_DISPLAY_PEAK_SOFT_KNEE_DB;
    const g = SPEC_DISPLAY_PEAK_SOFT_GAMMA;
    if (x <= knee || g <= 1.0001) return x;
    const span = hi - knee;
    if (span <= 0) return x;
    const t = (x - knee) / span;
    const u = Math.max(0, Math.min(1, t));
    return knee + span * Math.pow(u, g);
}

/** メーターと同色の縦グラデ（スペクトラム列の塗り）。 */
function spectrumMeterLikeGradient(canvasCtx, plotY, plotH) {
    const y0 = plotY + plotH;
    const y1 = plotY;
    const g = canvasCtx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, METER_GRAD_DEEP);
    g.addColorStop(0.26, METER_GRAD_MID);
    g.addColorStop(0.55, METER_GRAD_LIT);
    g.addColorStop(0.82, METER_GRAD_PALE);
    g.addColorStop(1, METER_GRAD_WHITE);
    return g;
}

const SPECTRUM_GRID_LABEL_TOP_ROW = [
    [20, '20'], [31.5, '31.5'], [50, '50'], [80, '80'], [125, '125'], [200, '200'], [315, '315'], [500, '500'], [800, '800'],
    [1250, '1k25'], [2000, '2k'], [3150, '3k15'], [5000, '5k'], [8000, '8k'], [12500, '12k5'], [20000, '20k']
];
const SPECTRUM_GRID_LABEL_BOT_ROW = [
    [25, '25'], [40, '40'], [63, '63'], [100, '100'], [160, '160'], [250, '250'], [400, '400'], [630, '630'],
    [1000, '1k'], [1600, '1k6'], [2500, '2k5'], [4000, '4k'], [6300, '6k3'], [10000, '10k'], [16000, '16k']
];

function collectSpectrumGridFreqs(nyquist) {
    const maxF = nyquist * 0.995;
    const s = new Set();
    for (const [f] of SPECTRUM_GRID_LABEL_TOP_ROW) if (f <= maxF) s.add(f);
    for (const [f] of SPECTRUM_GRID_LABEL_BOT_ROW) if (f <= maxF) s.add(f);
    return [...s].sort((a, b) => a - b);
}

function spectrumGridBandsForNyquist(nyquist, fLo) {
    const fHi = nyquist * 0.995;
    const grid = collectSpectrumGridFreqs(nyquist);
    const centersList = grid.filter((fc) => fc >= fLo - 1e-9 && fc <= fHi);
    const n = centersList.length;
    const low = new Float32Array(n);
    const high = new Float32Array(n);
    const centers = Float32Array.from(centersList);
    const gLo = Math.pow(2, -1 / 6);
    const gHi = Math.pow(2, 1 / 6);
    for (let i = 0; i < n; i++) {
        const c = centersList[i];
        let loB = i === 0 ? fLo : Math.sqrt(centersList[i - 1] * c);
        let hiB = i === n - 1 ? fHi : Math.sqrt(c * centersList[i + 1]);
        loB = Math.max(fLo, loB);
        hiB = Math.min(fHi, hiB);
        if (!(loB < hiB)) {
            low[i] = Math.max(fLo, c * gLo);
            high[i] = Math.min(fHi, c * gHi);
            if (low[i] >= high[i]) low[i] = Math.max(fLo, high[i] * 0.7);
        } else {
            low[i] = loB;
            high[i] = hiB;
        }
    }
    return { centers, low, high, n };
}

function spectrumBarRectsUniformGutter(plotX, plotW, nBands, gutterPx) {
    const plotR = plotX + plotW;
    const rects = new Array(nBands);
    if (nBands <= 0) return rects;
    const gutterTotal = (nBands - 1) * gutterPx;
    const avail = Math.max(0, plotR - plotX - gutterTotal);
    const base = Math.floor(avail / nBands);
    let rem = avail - base * nBands;
    let x = plotX;
    for (let b = 0; b < nBands; b++) {
        const bw = base + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        rects[b] = { x1: x, barW: bw };
        x += bw + (b < nBands - 1 ? gutterPx : 0);
    }
    return rects;
}

function spectrumBarCenterXForFreqHz(bands, rects, fHz) {
    const tol = Math.max(5e-4, Math.abs(fHz) * 1e-12);
    for (let b = 0; b < bands.n; b++) {
        if (Math.abs(bands.centers[b] - fHz) <= tol) {
            return rects[b].x1 + rects[b].barW * 0.5;
        }
    }
    return null;
}

function bandDbToLinearPow(db) {
    if (!isFinite(db) || db < -120) return 0;
    return Math.pow(10, db / 10);
}

/**
 * 線形パワー列へのガウスぼかし（正規化畳み込み）。σ≈0 はコピーのみ。
 * outReuse: 長さ n 以上の Float32Array を渡すとその先頭 n 要素に書き込み、同一参照を返す。
 */
function blurBandsLinearGaussian(bandLin, sigma, outReuse) {
    const n = bandLin.length;
    if (!(sigma > 1e-6)) return Float32Array.from(bandLin);
    const out = outReuse && outReuse.length >= n ? outReuse : new Float32Array(n);
    const r = Math.ceil(sigma * 4);
    for (let b = 0; b < n; b++) {
        let s = 0, w = 0;
        for (let k = -r; k <= r; k++) {
            const bk = b + k;
            if (bk < 0 || bk >= n) continue;
            const g = Math.exp(-(k * k) / (2 * sigma * sigma));
            s += bandLin[bk] * g;
            w += g;
        }
        out[b] = w > 0 ? s / w : 0;
    }
    return out;
}

function spectrumYAtDb(plotY, plotH, db) {
    return plotY + plotH * (1 - spectrumDbNormLinear(db));
}

function spectrumLedRowCount(loDb) {
    const loInt = Math.ceil(loDb - 1e-9);
    return Math.max(1, -loInt);
}

function spectrumLedPlotInnerHeightPx(loDb) {
    const n = spectrumLedRowCount(loDb);
    return n * SPEC_LED_CELL_HEIGHT_PX + Math.max(0, n - 1) * SPEC_LED_HLINE_PX;
}

function spectrumCanvasOuterHeightPx() {
    return SPEC_PAD_TOP_PX + spectrumLedPlotInnerHeightPx(spectrumDisplayDbMin) + SPEC_FREQ_LABELS_BELOW_PX;
}

function defaultSpectrumLedTrackHeightPx() {
    return Math.max(48, spectrumLedPlotInnerHeightPx(spectrumDisplayDbMin));
}

/** --spectrum-led-track-px / canvas 外周とメーターバーグラデの高さを同期。 */
function syncMonitorAnalysisLayoutHeights() {
    const trackPx = defaultSpectrumLedTrackHeightPx();
    const outerPx = spectrumCanvasOuterHeightPx();
    document.documentElement.style.setProperty('--spectrum-led-track-px', `${trackPx}px`);
    document.documentElement.style.setProperty('--spectrum-canvas-outer-px', `${outerPx}px`);
    syncMasterMeterBarBackgroundStyles(trackPx);
    const wrap = document.querySelector('.spectrum-canvas-wrap');
    if (wrap) wrap.style.minHeight = `${outerPx}px`;
}

installMasterMeterScaleUI();

/** LED 1 行 = 1 dB。y は canvas 座標（下向き正）。 */
function spectrumBuildLedCells(plotY, plotH, loDb) {
    const loInt = Math.ceil(loDb - 1e-9);
    const n = spectrumLedRowCount(loDb);
    const CELL = SPEC_LED_CELL_HEIGHT_PX;
    const LINE = SPEC_LED_HLINE_PX;
    const bot = new Array(n);
    const top = new Array(n);
    const yBottom = plotY + plotH;
    bot[0] = yBottom;
    top[0] = bot[0] - CELL;
    for (let i = 1; i < n; i++) {
        bot[i] = top[i - 1] - LINE;
        top[i] = bot[i] - CELL;
    }
    return { n, loInt, bot, top };
}

function spectrumLedDimCellColor(cellDbLoInt) {
    return SPEC_LED_DIM_GREEN;
}

function spectrumAxisDbText(db) {
    if (db === 0) return '+0';
    return String(db);
}

/** 行間の黒帯。続けてピークドットを描くので順序固定。 */
function spectrumDrawLedInterRowBlack(plotX, plotY, plotW, plotH, loDb) {
    const cells = spectrumBuildLedCells(plotY, plotH, loDb);
    const n = cells.n;
    if (n < 2) return;
    canvasCtx.fillStyle = SPEC_GRID_BLACK;
    canvasCtx.shadowBlur = 0;
    canvasCtx.shadowColor = 'transparent';
    const x0 = Math.round(plotX);
    const wPx = Math.max(0, Math.round(plotX + plotW) - x0);
    for (let i = 0; i < n - 1; i++) {
        const y = cells.bot[i + 1];
        const hh = cells.top[i] - cells.bot[i + 1];
        if (hh > 0) canvasCtx.fillRect(x0, y, wPx, hh);
    }
}

function defaultSpectrumNyquistHz() {
    return audioCtx && audioCtx.sampleRate ? audioCtx.sampleRate * 0.5 : 22050;
}

function spectrumComputeGeometry(nyquist, w, h) {
    const padL = 44;
    const padR = 44;
    const padT = SPEC_PAD_TOP_PX;
    const plotH = spectrumLedPlotInnerHeightPx(spectrumDisplayDbMin);
    const plotX = padL + SPECTRUM_INSET_LEFT_PX;
    const plotY = padT;
    const plotW = w - padL - padR - SPECTRUM_INSET_LEFT_PX - SPECTRUM_INSET_RIGHT_PX;
    const fLo = SPECTRUM_GRID_FLOOR_HZ;
    const fHi = nyquist * 0.995;
    const freqToXLog = (f) => {
        const ff = Math.max(fLo, Math.min(fHi, f));
        const t = Math.log(ff / fLo) / Math.log(fHi / fLo);
        return plotX + t * plotW;
    };
    const maxFLbl = nyquist * 0.995;
    return { plotX, plotY, plotW, plotH, padT, nyquist, fLo, fHi, freqToXLog, maxFLbl };
}

function spectrumDrawChrome(w, h, g) {
    const { plotX, plotY, plotW, plotH, freqToXLog, maxFLbl } = g;
    canvasCtx.shadowBlur = 0;
    canvasCtx.shadowColor = 'transparent';
    canvasCtx.fillStyle = '#242629';
    canvasCtx.fillRect(0, 0, w, h);
    /* プロット内は黒ベース（帯域間ガターや罫線まわりに #242629 が挟まらない） */
    canvasCtx.fillStyle = SPEC_GRID_BLACK;
    canvasCtx.fillRect(plotX, plotY, plotW, plotH);

    canvasCtx.lineWidth = 1;
    const dbMin = spectrumDisplayDbMin;
    canvasCtx.font = `normal ${MONITOR_CHROME_FONT_PX}px "Courier New", Courier, monospace`;
    canvasCtx.textBaseline = 'middle';
    canvasCtx.fillStyle = '#ffffff';
    const labelSet = new Set();
    for (let db = 0; db >= dbMin; db -= 10) labelSet.add(db);
    labelSet.add(dbMin);
    for (const db of [...labelSet].sort((a, b) => b - a)) {
        const y = plotY + plotH * (1 - spectrumDbNormLinear(db));
        const t = spectrumAxisDbText(db);
        canvasCtx.textAlign = 'right';
        canvasCtx.fillText(t, plotX - 5, y);
        canvasCtx.textAlign = 'left';
        canvasCtx.fillText(t, plotX + plotW + 5, y);
    }

    const gridLines = collectSpectrumGridFreqs(g.nyquist);
    const py = Math.round(plotY);
    const ph = Math.max(0, Math.round(plotY + plotH) - py);
    canvasCtx.fillStyle = SPEC_GRID_BLACK;
    canvasCtx.shadowBlur = 0;
    canvasCtx.shadowColor = 'transparent';
    for (const f of gridLines) {
        const x = Math.round(freqToXLog(f));
        if (ph > 0) canvasCtx.fillRect(x, py, 1, ph);
    }
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.font = `normal ${MONITOR_CHROME_FONT_PX}px "Courier New", Courier, monospace`;
    canvasCtx.textBaseline = 'top';
    canvasCtx.textAlign = 'center';
    const row1y = plotY + plotH + 5;
    const row2y = plotY + plotH + 14;
    const bandsLbl = spectrumGridBandsForNyquist(g.nyquist, SPECTRUM_GRID_FLOOR_HZ);
    const rectsLbl = spectrumBarRectsUniformGutter(
        plotX,
        plotW,
        bandsLbl.n,
        SPECTRUM_BAR_GUTTER_PX
    );
    for (const [f, text] of SPECTRUM_GRID_LABEL_TOP_ROW) {
        if (f > maxFLbl) continue;
        const cx = spectrumBarCenterXForFreqHz(bandsLbl, rectsLbl, f);
        const x = cx !== null ? cx : freqToXLog(f);
        canvasCtx.fillText(text, x, row1y);
    }
    for (const [f, text] of SPECTRUM_GRID_LABEL_BOT_ROW) {
        if (f > maxFLbl) continue;
        const cx = spectrumBarCenterXForFreqHz(bandsLbl, rectsLbl, f);
        const x = cx !== null ? cx : freqToXLog(f);
        canvasCtx.fillText(text, x, row2y);
    }
}

function spectrumDrawBarsFromEnv(bands, plotX, plotY, plotW, plotH, cellsOpt) {
    const nBands = bands.n;
    const rects = spectrumBarRectsUniformGutter(plotX, plotW, nBands, SPECTRUM_BAR_GUTTER_PX);
    const loDb = spectrumDisplayDbMin;
    const cells = cellsOpt || spectrumBuildLedCells(plotY, plotH, loDb);
    const { n: nLedRows, loInt } = cells;
    const specMeterGrad = spectrumMeterLikeGradient(canvasCtx, plotY, plotH);
    canvasCtx.shadowBlur = 0;
    canvasCtx.shadowColor = 'transparent';
    for (let b = 0; b < nBands; b++) {
        const raw = spectrumBandEnv[b];
        const barDb = Math.max(
            spectrumDisplayDbMin,
            Math.min(SPECTRUM_DB_MAX, isFinite(raw) ? raw : spectrumDisplayDbMin)
        );
        const norm = spectrumDbNormLinear(barDb);
        const { x1, barW } = rects[b];
        const barHeight = norm * plotH;

        for (let i = 0; i < nLedRows; i++) {
            const yTop = cells.top[i];
            const yBot = cells.bot[i];
            const hCell = yBot - yTop;
            if (hCell <= 0) continue;
            const n = loInt + i;
            canvasCtx.fillStyle = spectrumLedDimCellColor(n);
            canvasCtx.fillRect(x1, yTop, barW, hCell);
        }

        if (barHeight > 0.25) {
            canvasCtx.fillStyle = specMeterGrad;
            for (let i = 0; i < nLedRows; i++) {
                const n = loInt + i;
                const segLo = n;
                const segHi = n + 1;
                if (!(segLo < barDb && segHi > loDb)) continue;
                const yTop = cells.top[i];
                const yBot = cells.bot[i];
                const hLit = yBot - yTop;
                if (hLit <= 0) continue;
                canvasCtx.fillRect(x1, yTop, barW, hLit);
            }
        }
    }
    return { rects, nBands };
}

function spectrumDrawSpectrumColumnGutters(plotX, plotY, plotW, plotH, rects, nBands) {
    const y0 = Math.round(plotY);
    const hPx = Math.max(0, Math.round(plotY + plotH) - y0);
    if (hPx <= 0 || nBands <= 0) return;
    canvasCtx.fillStyle = SPEC_GRID_BLACK;
    const xPlotL = Math.round(plotX);
    const xPlotR = Math.round(plotX + plotW) - 1;
    canvasCtx.fillRect(xPlotL, y0, 1, hPx);
    for (let b = 0; b < nBands - 1; b++) {
        const xSep = rects[b].x1 + rects[b].barW;
        canvasCtx.fillRect(xSep, y0, 1, hPx);
    }
    if (xPlotR !== xPlotL) {
        canvasCtx.fillRect(xPlotR, y0, 1, hPx);
    }
}

function spectrumDrawSpectrumLedPeaks(bands, plotY, plotH, rects, cellsOpt) {
    const nBands = bands.n;
    const loDb = spectrumDisplayDbMin;
    const cells = cellsOpt || spectrumBuildLedCells(plotY, plotH, loDb);
    canvasCtx.shadowBlur = 0;
    canvasCtx.shadowColor = 'transparent';
    for (let b = 0; b < nBands; b++) {
        const rawPk = spectrumPeakHoldDb[b];
        const pkDb = Math.max(
            spectrumDisplayDbMin,
            Math.min(SPECTRUM_DB_MAX, isFinite(rawPk) ? rawPk : spectrumDisplayDbMin)
        );
        if (!(pkDb > loDb + 1e-4)) continue;
        const iPk = Math.max(
            0,
            Math.min(cells.n - 1, Math.floor(pkDb) - cells.loInt)
        );
        const yTop = cells.top[iPk];
        const yBot = cells.bot[iPk];
        const { x1, barW } = rects[b];
        canvasCtx.fillStyle = meterLevelColorLerp(spectrumDbNormLinear(pkDb));
        canvasCtx.fillRect(x1, yTop, barW, yBot - yTop);
    }
}

/** HiDPI でラベルが滲まないようバッキングストアを DPR 倍にする（描画は CSS ピクセル座標のまま） */
function spectrumResizeCanvasBackingStore() {
    if (!canvas || !canvasCtx) return null;
    const wCss = canvas.clientWidth | 0;
    if (wCss < 2) return null;
    const hCss = spectrumCanvasOuterHeightPx();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.max(1, Math.round(wCss * dpr));
    canvas.height = Math.max(1, Math.round(hCss * dpr));
    canvas.style.width = `${wCss}px`;
    canvas.style.height = `${hCss}px`;
    canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvasCtx.imageSmoothingEnabled = false;
    return { w: wCss, h: hCss };
}

function paintSpectrumIdle() {
    if (!canvas || !canvasCtx) return;
    const sized = spectrumResizeCanvasBackingStore();
    if (!sized) return;
    const w = sized.w;
    const hSpec = sized.h;
    const nyquist = audioCtx && audioCtx.sampleRate ? audioCtx.sampleRate * 0.5 : defaultSpectrumNyquistHz();
    const g = spectrumComputeGeometry(nyquist, w, hSpec);
    spectrumDrawChrome(w, hSpec, g);
    const bands = spectrumGridBandsForNyquist(nyquist, SPECTRUM_GRID_FLOOR_HZ);
    const nBands = bands.n;
    const { plotX, plotY, plotW, plotH } = g;
    const floor = spectrumDisplayDbMin;
    if (!spectrumBandEnv || spectrumBandEnv.length !== nBands) {
        spectrumBandEnv = new Float32Array(nBands).fill(floor);
    } else {
        for (let b = 0; b < nBands; b++) spectrumBandEnv[b] = floor;
    }
    if (!spectrumPeakHoldDb || spectrumPeakHoldDb.length !== nBands) {
        spectrumPeakHoldDb = new Float32Array(nBands).fill(floor);
        spectrumPeakHoldUntil = new Float32Array(nBands).fill(-1e9);
    } else {
        for (let b = 0; b < nBands; b++) {
            spectrumPeakHoldDb[b] = floor;
            spectrumPeakHoldUntil[b] = -1e9;
        }
    }
    const cellsIdle = spectrumBuildLedCells(plotY, plotH, floor);
    const { rects } = spectrumDrawBarsFromEnv(bands, plotX, plotY, plotW, plotH, cellsIdle);
    spectrumDrawLedInterRowBlack(plotX, plotY, plotW, plotH, spectrumDisplayDbMin);
    spectrumDrawSpectrumColumnGutters(plotX, plotY, plotW, plotH, rects, nBands);
    spectrumDrawSpectrumLedPeaks(bands, plotY, plotH, rects, cellsIdle);
    syncMonitorAnalysisLayoutHeights();
}

function drawSpectrum() {
    if (!masterAnalyser || !audioCtx) return;
    const ctxNow = audioCtx.currentTime;
    const dtSp = lastSpectrumDrawT > 0 ? Math.min(0.12, Math.max(0, ctxNow - lastSpectrumDrawT)) : (1 / 60);
    lastSpectrumDrawT = ctxNow;

    const bufferLength = masterAnalyser.frequencyBinCount;
    if (!spectrumScratchFloat || spectrumScratchFloatLen !== bufferLength) {
        spectrumScratchFloatLen = bufferLength;
        spectrumScratchFloat = new Float32Array(bufferLength);
    }
    const floatData = spectrumScratchFloat;
    masterAnalyser.getFloatFrequencyData(floatData);

    let tdPeakLin = 0;
    if (anaL && anaR) {
        const tdLen = anaL.fftSize;
        if (!spectrumScratchTdL || spectrumScratchTdLen !== tdLen) {
            spectrumScratchTdLen = tdLen;
            spectrumScratchTdL = new Float32Array(tdLen);
            spectrumScratchTdR = new Float32Array(tdLen);
        }
        const tdl = spectrumScratchTdL;
        const tdr = spectrumScratchTdR;
        anaL.getFloatTimeDomainData(tdl);
        anaR.getFloatTimeDomainData(tdr);
        for (let i = 0; i < tdl.length; i++) {
            tdPeakLin = Math.max(tdPeakLin, Math.abs(tdl[i]), Math.abs(tdr[i]));
        }
    }
    let fftBinMax = -300;
    for (let i = 0; i < bufferLength; i++) {
        if (floatData[i] > fftBinMax) fftBinMax = floatData[i];
    }
    if (anaL && anaR && tdPeakLin > 1e-8) {
        const tdPeakDb = 20 * Math.log10(tdPeakLin);
        if (isFinite(tdPeakDb) && isFinite(fftBinMax) && fftBinMax > -115) {
            let dCal = tdPeakDb - fftBinMax;
            dCal = Math.max(-2, Math.min(SPEC_FFT_CAL_DB_MAX, dCal));
            if (Math.abs(dCal) > 0.05) {
                for (let i = 0; i < bufferLength; i++) {
                    if (isFinite(floatData[i])) floatData[i] += dCal;
                }
            }
        }
    }

    const sized = spectrumResizeCanvasBackingStore();
    if (!sized) return;
    const w = sized.w;
    const hSpec = sized.h;

    const nyquist = audioCtx.sampleRate / 2;
    const g = spectrumComputeGeometry(nyquist, w, hSpec);
    const { plotX, plotY, plotW, plotH, fLo } = g;
    spectrumDrawChrome(w, hSpec, g);

    const bands = spectrumGridBandsForNyquist(nyquist, SPECTRUM_GRID_FLOOR_HZ);
    const nBands = bands.n;
    if (!spectrumScratchBandDb || spectrumScratchBandNb !== nBands) {
        spectrumScratchBandNb = nBands;
        spectrumScratchBandDb = new Float32Array(nBands);
        spectrumScratchBandLin = new Float32Array(nBands);
        spectrumScratchDisplayDb = new Float32Array(nBands);
        spectrumScratchBlurredLin = new Float32Array(nBands);
    }
    const bandDb = spectrumScratchBandDb;
    const bandLin = spectrumScratchBandLin;
    const displayDb = spectrumScratchDisplayDb;
    bandLin.fill(0);
    const binW = nyquist / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
        const fLeft = i * binW;
        const fRight = (i + 1) * binW;
        if (fRight <= fLo) continue;
        const db = floatData[i];
        if (!isFinite(db)) continue;
        const pBin = bandDbToLinearPow(db);
        const bw = fRight - fLeft;
        if (bw <= 0) continue;
        for (let b = 0; b < nBands; b++) {
            const bLow = bands.low[b];
            const bHigh = bands.high[b];
            const o0 = Math.max(fLeft, bLow);
            const o1 = Math.min(fRight, bHigh);
            if (o1 <= o0) continue;
            bandLin[b] += pBin * ((o1 - o0) / bw);
        }
    }
    for (let b = 0; b < nBands; b++) {
        bandDb[b] = bandLin[b] > 1e-15 ? 10 * Math.log10(bandLin[b]) : -200;
    }

    if (SPEC_BLUR_SIGMA > 1e-6) {
        let bMxLin = 0;
        let mxLin = -1;
        for (let b = 0; b < nBands; b++) {
            if (bandLin[b] > mxLin) {
                mxLin = bandLin[b];
                bMxLin = b;
            }
        }
        const useSkirtShape = mxLin > SPEC_SKIRT_MIN_PEAK_LIN;
        const blurredLin = blurBandsLinearGaussian(bandLin, SPEC_BLUR_SIGMA, spectrumScratchBlurredLin);
        for (let b = 0; b < nBands; b++) {
            let mult = 1;
            if (useSkirtShape) {
                const d = Math.abs(b - bMxLin);
                if (d === 1) mult = SPEC_SKIRT_NEIGHBOR_ATTEN;
                else if (d === 2) mult = SPEC_SKIRT_OUTER_BOOST;
                else if (d === 3) mult = SPEC_SKIRT_RING3_MULT;
                else mult = SPEC_SKIRT_RING4PLUS_MULT;
            }
            const shapedLin = blurredLin[b] * mult;
            const mergedLin = Math.max(bandLin[b], shapedLin);
            displayDb[b] = mergedLin > 1e-18 ? 10 * Math.log10(mergedLin) : -200;
        }
    } else {
        for (let b = 0; b < nBands; b++) displayDb[b] = bandDb[b];
    }

    let bMx = -1;
    let mxDisp = -300;
    for (let b = 0; b < nBands; b++) {
        if (displayDb[b] > mxDisp) {
            mxDisp = displayDb[b];
            bMx = b;
        }
    }
    let secondDisp = -300;
    for (let b = 0; b < nBands; b++) {
        if (b !== bMx && displayDb[b] > secondDisp) secondDisp = displayDb[b];
    }
    if (
        anaL &&
        anaR &&
        tdPeakLin > 1e-8 &&
        mxDisp > -115 &&
        isFinite(secondDisp) &&
        mxDisp - secondDisp >= SPEC_BELL_CALIB_MIN_DOMINANCE_DB
    ) {
        const tdPeakDb = 20 * Math.log10(tdPeakLin);
        if (isFinite(tdPeakDb)) {
            let dBell = tdPeakDb - mxDisp;
            dBell = Math.max(0, Math.min(SPEC_FFT_CAL_DB_MAX, dBell));
            if (dBell > 0.04) {
                for (let b = 0; b < nBands; b++) {
                    if (displayDb[b] > -199) {
                        displayDb[b] = Math.min(SPECTRUM_DB_MAX, displayDb[b] + dBell);
                    }
                }
            }
        }
    }

    if (!spectrumBandEnv || spectrumBandEnv.length !== nBands) {
        spectrumBandEnv = new Float32Array(nBands).fill(spectrumDisplayDbMin);
    }
    const qpUp =
        SPEC_SPECT_QP_RISE_SEC > 1e-9
            ? Math.min(1, 1 - Math.exp(-dtSp / SPEC_SPECT_QP_RISE_SEC))
            : 1;
    const qpDn = Math.min(1, 1 - Math.exp(-dtSp / SPEC_SPECT_QP_FALL_SEC));
    for (let b = 0; b < nBands; b++) {
        const rawTgt = Math.max(
            spectrumDisplayDbMin,
            Math.min(SPECTRUM_DB_MAX, isFinite(displayDb[b]) ? displayDb[b] : spectrumDisplayDbMin)
        );
        const tgt = spectrumDisplayPeakSoften(rawTgt);
        let env = spectrumBandEnv[b];
        if (!isFinite(env)) env = spectrumDisplayDbMin;
        const k = tgt >= env ? qpUp : qpDn;
        env += (tgt - env) * k;
        spectrumBandEnv[b] = Math.max(
            spectrumDisplayDbMin,
            Math.min(SPECTRUM_DB_MAX, env)
        );
    }

    if (!spectrumPeakHoldDb || spectrumPeakHoldDb.length !== nBands) {
        spectrumPeakHoldDb = new Float32Array(nBands).fill(spectrumDisplayDbMin);
        spectrumPeakHoldUntil = new Float32Array(nBands).fill(-1e9);
    }
    let bPkHold = 0;
    let vPkHold = spectrumDisplayDbMin;
    for (let b = 0; b < nBands; b++) {
        const v = spectrumBandEnv[b];
        if (isFinite(v) && v > vPkHold) {
            vPkHold = v;
            bPkHold = b;
        }
    }
    for (let b = 0; b < nBands; b++) {
        const inst = Math.max(
            spectrumDisplayDbMin,
            Math.min(SPECTRUM_DB_MAX, isFinite(spectrumBandEnv[b]) ? spectrumBandEnv[b] : spectrumDisplayDbMin)
        );
        const distPk = Math.abs(b - bPkHold);
        const holdSec =
            distPk === 0
                ? SPEC_SPECT_PEAK_HOLD_CENTER_SEC
                : distPk === 1
                  ? SPEC_PEAK_HOLD_NEIGHBOR_SEC
                  : SPEC_PEAK_HOLD_OUTER_SEC;
        let held = spectrumPeakHoldDb[b];
        if (inst > held) {
            held = inst;
            spectrumPeakHoldUntil[b] = ctxNow + holdSec;
        } else if (ctxNow >= spectrumPeakHoldUntil[b]) {
            let rel = SPEC_PEAK_RELEASE_DB_PER_SEC * dtSp;
            if (distPk === 1) rel *= SPEC_PEAK_RELEASE_MULT_NEIGHBOR;
            else if (distPk >= 2) rel *= SPEC_PEAK_RELEASE_MULT_OUTER;
            held = Math.max(inst, held - rel);
        }
        spectrumPeakHoldDb[b] = Math.max(
            spectrumDisplayDbMin,
            Math.min(SPECTRUM_DB_MAX, held)
        );
    }

    const cellsDraw = spectrumBuildLedCells(plotY, plotH, spectrumDisplayDbMin);
    const { rects } = spectrumDrawBarsFromEnv(bands, plotX, plotY, plotW, plotH, cellsDraw);
    spectrumDrawLedInterRowBlack(plotX, plotY, plotW, plotH, spectrumDisplayDbMin);
    spectrumDrawSpectrumColumnGutters(plotX, plotY, plotW, plotH, rects, nBands);
    spectrumDrawSpectrumLedPeaks(bands, plotY, plotH, rects, cellsDraw);
    syncMonitorAnalysisLayoutHeights();
}

function extinguishMonitorDisplays() {
    document.querySelectorAll('.clip-lamp').forEach((l) => {
        l.classList.remove('clip-on');
        if (clipTimers[l.id]) clearTimeout(clipTimers[l.id]);
    });
    const mvWrapEx = document.querySelector('.master-vol-container');
    if (mvWrapEx) mvWrapEx.classList.remove('gain-reduce-glow');
    if (gainReduceGlowTimer) { clearTimeout(gainReduceGlowTimer); gainReduceGlowTimer = null; }
    const mEx = document.querySelector('.m-meter-container');
    const mExH = mEx && mEx.clientHeight > 8 ? mEx.clientHeight : defaultSpectrumLedTrackHeightPx();
    const exHoldHpx = mExH / Math.abs(METER_DB_MAX - meterDisplayDbMin);
    syncMasterMeterBarBackgroundStyles(mExH);
    for (const s of ['l', 'r']) {
        const elPk = document.getElementById(`m-peak-${s}`);
        const elRms = document.getElementById(`m-rms-${s}`);
        if (elPk) {
            elPk.style.height = '0%';
        }
        if (elRms) {
            elRms.style.height = '0%';
        }
        const phl = document.getElementById(`m-peak-${s}-hold`);
        if (phl) {
            phl.style.height = `${exHoldHpx}px`;
            phl.style.bottom = '0%';
            phl.style.opacity = '0';
            phl.style.background = meterLevelColorLerp(0);
            phl.style.borderColor = masterMeterHoldBorderColorForDb(meterDisplayDbMin);
        }
        const rhl = document.getElementById(`m-rms-${s}-hold`);
        if (rhl) {
            rhl.style.height = `${exHoldHpx}px`;
            rhl.style.bottom = '0%';
            rhl.style.opacity = '0';
            rhl.style.background = meterLevelColorLerp(0);
            rhl.style.borderColor = masterMeterHoldBorderColorForDb(meterDisplayDbMin);
        }
        const vp = document.getElementById(`val-peak-${s}`);
        const vr = document.getElementById(`val-rms-${s}`);
        if (vp) {
            vp.innerText = formatMeterDbReadout(meterDisplayDbMin);
            vp.style.color = '#ffffff';
        }
        if (vr) {
            vr.innerText = formatMeterDbReadout(meterDisplayDbMin);
            vr.style.color = '#ffffff';
        }
    }
    for (let i = 0; i < 4; i++) {
        const el = document.getElementById(`meter-${i}`);
        if (el) el.style.height = '0%';
    }
    spectrumBandEnv = null;
    spectrumPeakHoldDb = null;
    spectrumPeakHoldUntil = null;
    lastSpectrumDrawT = 0;
    paintSpectrumIdle();
}

const playSync = (offset = 0) => {
    stopSources();
    if (!audioCtx) return;
    startTimeInCtx = audioCtx.currentTime;
    pauseOffset = offset;
    const playStartTime = audioCtx.currentTime + 0.1;
    sources = [];
    tracks.forEach(t => {
        if (t && t.buffer) {
            const s = audioCtx.createBufferSource();
            s.buffer = t.buffer; 
            s.connect(t.gainNode);
            s.start(playStartTime, offset);
            sources.push(s);
        }
    });
    const remainingTime = (shortestDuration - offset);
    loopTimeout = setTimeout(() => { if(isPlaying) playSync(0); }, remainingTime * 1000);
    if (!requestAnimId) updateUIFrame();
};

function stopSources() {
    if (sources) sources.forEach(s => { try { s.stop(); } catch(e){} });
    sources = [];
    if (loopTimeout) clearTimeout(loopTimeout);
}

async function startTransportFromStart() {
    initAudio();
    try {
        if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    } catch (_) {}
    isPlaying = true;
    document.querySelectorAll('.clip-lamp').forEach(l => l.classList.remove('clip-on'));
    resetMeterChState();
    playSync(0);
    syncTransportButton();
}

document.getElementById('playStopBtn').onclick = async () => {
    if (isPlaying) {
        isPlaying = false;
        writeLog('Transport: Stop');
        stopSources();
        if (requestAnimId) { cancelAnimationFrame(requestAnimId); requestAnimId = null; }
        resetMeterChState();
        extinguishMonitorDisplays();
        syncTransportButton();
        return;
    }
    if (!tracks.some((t) => t)) {
        const ok = await restoreSessionFromIndexedDB();
        if (!ok || !tracks.some((t) => t)) return;
    }
    writeLog('Transport: Play');
    await startTransportFromStart();
};

document.getElementById('seekBar').oninput = (e) => {
    if (!isPlaying) return;
    const targetOffset = (parseFloat(e.target.value) / 100) * shortestDuration;
    playSync(targetOffset);
};

function updateMix() {
    if (!audioCtx) {
        updateAllFaderButtons();
        return;
    }
    const hasSolo = tracks.some(t => t && t.isSolo);
    tracks.forEach((t, i) => {
        if (!t) return;
        const sliderVal = parseFloat(document.getElementById(`vol-${i}`).value);
        let finalGain = (t.isMute || (hasSolo && !t.isSolo)) ? 0 : getPracticalGain(sliderVal);
        t.gainNode.gain.setTargetAtTime(finalGain, audioCtx.currentTime, 0.02);
    });
    updateAllFaderButtons();
    schedulePersistSession();
}

function cancelFaderTimer(i) { if (faderTimers[i]) { clearInterval(faderTimers[i]); faderTimers[i] = null; } }

window.fadeTo = (i, target) => {
    if(!tracks[i] || !audioCtx) return;
    if (target >= 1 && isFaderAtMax(i)) return;
    if (target <= 0 && isFaderAtMin(i)) return;
    const interrupting = faderTimers[i] != null;
    const uiFadeSec = normalizeFadeTimeSeconds(document.getElementById('fadeTime').value);
    let fadeTime;
    if (interrupting && faderFadeEffectiveSec[i] != null) {
        fadeTime = Math.max(1, Math.ceil(faderFadeEffectiveSec[i] / 2));
    } else {
        fadeTime = uiFadeSec;
    }
    faderFadeEffectiveSec[i] = fadeTime;
    cancelFaderTimer(i);
    writeLog(`Slot ${i+1}: Fade to ${target === 1 ? 'MAX' : 'MIN'} over ${fadeTime}s`);
    const slider = document.getElementById(`vol-${i}`);
    const startVal = parseFloat(slider.value);
    const startTime = Date.now();
    faderTimers[i] = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed >= fadeTime) {
            slider.value = target;
            cancelFaderTimer(i);
            faderFadeEffectiveSec[i] = null;
        }
        else { slider.value = startVal + (target - startVal) * (elapsed / fadeTime); }
        updateMix();
    }, 30);
};

window.jumpTo = (i, v) => { 
    if (!tracks[i]) return; 
    if (v >= 1 && isFaderAtMax(i)) return;
    if (v <= 0 && isFaderAtMin(i)) return;
    cancelFaderTimer(i);
    faderFadeEffectiveSec[i] = null;
    document.getElementById(`vol-${i}`).value = v; 
    updateMix(); 
    writeLog(`Slot ${i+1}: Instant set to ${v === 1 ? 'MAX' : 'MIN'}`);
};

window.toggleMute = (i) => { 
    if(!tracks[i]) return; 
    tracks[i].isMute = !tracks[i].isMute; 
    document.getElementById(`mute-${i}`).classList.toggle('mute-on', tracks[i].isMute); 
    updateMix(); 
    writeLog(`Slot ${i+1}: Mute ${tracks[i].isMute ? 'ON' : 'OFF'}`);
};

window.toggleSolo = (i) => { 
    if(!tracks[i]) return; 
    tracks[i].isSolo = !tracks[i].isSolo; 
    document.getElementById(`solo-${i}`).classList.toggle('solo-on', tracks[i].isSolo); 
    updateMix(); 
    writeLog(`Slot ${i+1}: Solo ${tracks[i].isSolo ? 'ON' : 'OFF'}`);
};

window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;

    const numpadSeekDigit = {
        Numpad0: 0, Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4,
        Numpad5: 5, Numpad6: 6, Numpad7: 7, Numpad8: 8, Numpad9: 9
    };
    if (Object.prototype.hasOwnProperty.call(numpadSeekDigit, e.code)) {
        if (!isPlaying || shortestDuration <= 0 || !audioCtx) return;
        e.preventDefault();
        const d = numpadSeekDigit[e.code];
        const targetOffset = Math.max(0, Math.min(shortestDuration - 0.1, (d / 10) * shortestDuration));
        playSync(targetOffset);
        writeLog(`Seek: ${d * 10}% (${formatTime(targetOffset)})`);
        return;
    }

    if (e.code === 'NumpadDecimal') {
        e.preventDefault();
        initAudio();
        const mvSlider = document.getElementById('masterVolSlider');
        mvSlider.value = '1.00';
        if (masterGain) masterGain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.05);
        document.getElementById('masterVolDisp').innerText = formatMasterVolDisplayText(1.0);
        writeLog('MASTER: 100% (numpad decimal)');
        return;
    }

    if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        const fadeEl = document.getElementById('fadeTime');
        if (!fadeEl) return;
        let v = normalizeFadeTimeSeconds(fadeEl.value);
        if (e.code === 'NumpadAdd') v = Math.min(FADE_TIME_MAX_SEC, v + 1);
        else v = Math.max(FADE_TIME_MIN_SEC, v - 1);
        fadeEl.value = String(v);
        saveUiPrefsToLocalStorage();
        writeLog(`Fade duration: ${v}s (numpad ${e.code === 'NumpadAdd' ? '+' : '-'})`);
        return;
    }
    
    if (e.code === 'Space') {
        e.preventDefault();
        if (isPlaying) document.getElementById('playStopBtn').click();
        else if (!document.getElementById('playStopBtn').disabled) document.getElementById('playStopBtn').click();
        return;
    }

    if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
        e.preventDefault();
        if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
            if (!isPlaying || shortestDuration <= 0) return;
            const currentPos = ((audioCtx.currentTime - startTimeInCtx + pauseOffset) % shortestDuration);
            const step = e.shiftKey ? 10 : 1;
            const shift = (e.code === 'ArrowRight' ? step : -step);
            let targetPos = currentPos + shift;
            targetPos = Math.max(0, Math.min(shortestDuration - 0.1, targetPos));
            playSync(targetPos);
            writeLog(`Seek: ${formatTime(targetPos)} (${e.shiftKey ? 'Large' : 'Fine'})`);
        } else {
            initAudio();
            const mvSlider = document.getElementById('masterVolSlider');
            const step = e.shiftKey ? 0.1 : 0.01;
            let val = parseFloat(mvSlider.value);
            val = (e.code === 'ArrowUp' ? val + step : val - step);
            val = Math.min(2.0, Math.max(0, val));
            mvSlider.value = val.toFixed(2);
            masterGain.gain.setTargetAtTime(val, audioCtx.currentTime, 0.05);
            document.getElementById('masterVolDisp').innerText = formatMasterVolDisplayText(val);
        }
        return;
    }

    const codeMap = {
        'Digit1': 0, 'Digit2': 1, 'Digit3': 2, 'Digit4': 3,
        'KeyQ': 0,   'KeyW': 1,   'KeyE': 2,   'KeyR': 3,
        'KeyA': 0,   'KeyS': 1,   'KeyD': 2,   'KeyF': 3,
        'KeyZ': 0,   'KeyX': 1,   'KeyC': 2,   'KeyV': 3
    };

    const idx = codeMap[e.code];
    if (idx !== undefined && tracks[idx]) {
        if (e.code.startsWith('Digit')) {
            if (e.shiftKey) {
                if (!isFaderAtMax(idx)) jumpTo(idx, 1.0);
            } else {
                if (!isFaderAtMax(idx)) fadeTo(idx, 1.0);
            }
        } else if (['KeyQ','KeyW','KeyE','KeyR'].includes(e.code)) {
            if (e.shiftKey) {
                if (!isFaderAtMin(idx)) jumpTo(idx, 0.0);
            } else {
                if (!isFaderAtMin(idx)) fadeTo(idx, 0.0);
            }
        } else if (['KeyA','KeyS','KeyD','KeyF'].includes(e.code)) {
            toggleSolo(idx);
        } else if (['KeyZ','KeyX','KeyC','KeyV'].includes(e.code)) {
            toggleMute(idx);
        }
    }
});

(async () => {
    await restoreSessionFromIndexedDB({ startup: true });
})();