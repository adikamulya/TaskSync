// ==UserScript==
// @name         Sinkronisasi LMS Telkom University ke Google Tasks
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Ekstrak tugas LMS Telkom University ke Google Tasks
// @match        https://lms.telkomuniversity.ac.id/*
// @match        https://adikamulya.github.io/TaskSync/*
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      tasks.googleapis.com
// @connect      oauth2.googleapis.com
// ==/UserScript==

(function () {
    'use strict';

    // ====================== KONFIGURASI ======================
    const CLIENT_ID = '';

    // ISI INI supaya login tidak perlu diulang tiap 1 jam (pakai Authorization Code + PKCE + refresh token).
    // Ambil dari Google Cloud Console > APIs & Services > Credentials > klik OAuth client kamu.
    // Kalau dikosongkan, script memakai mode lama (implicit flow, token hanya 1 jam).
    // JANGAN bagikan script ini ke orang lain kalau secret sudah terisi.
    const CLIENT_SECRET = '';

    // URL GitHub Pages halaman beranda (harus diakhiri "/") dan sama dengan @match di atas.
    const BERANDA_PREFIX = 'https://adikamulya.github.io/TaskSync/';
    const IS_BERANDA = window.location.href.startsWith(BERANDA_PREFIX);

    const REDIRECT_URI = 'http://localhost';
    const SCOPES = 'https://www.googleapis.com/auth/tasks';
    const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

    const MAX_HISTORY = 2000;
    const MAX_LOG = 500; // batas entri per daftar log (yang paling lama dibuang)
    const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;
    const LOCK_TTL_MS = 90 * 1000;
    const USE_CODE_FLOW = CLIENT_SECRET !== '';

    // Singkatan mata kuliah. Kunci = potongan nama di LMS (huruf besar), nilai = singkatan.
    // Mata kuliah yang tidak ada di daftar ini ditulis dengan nama aslinya (sudah dibersihkan).
    // Praktikum dikenali otomatis: nama course "... S1 INFORMATIKA" (tanpa kode kelas) -> singkatan + " PRAK".
    // Kelas biasa punya kode kelas, mis. "STRUKTUR DATA BS1IF-49-REG01 [FLN]".
    const COURSE_ALIASES = {
        'TEORI PELUANG': 'TEPE',
        'SISTEM BASIS DATA': 'SBD',
        'TEORI BAHASA DAN AUTOMATA': 'TBA',
        'STRUKTUR DATA': 'STRUKDAT',
        'STUKTUR DATA': 'STRUKDAT',
        'SISTEM OPERASI': 'SISOP',
        'ANALISIS KOMPLEKSITAS ALGORITMA': 'AKA',
        'ANALISIS DAN PERANCANGAN PERANGKAT LUNAK': 'APPL'
    };

    // ====================== UTILITAS ======================
    const MONTHS = {
        jan: 1, januari: 1, january: 1,
        feb: 2, februari: 2, february: 2,
        mar: 3, maret: 3, march: 3,
        apr: 4, april: 4,
        may: 5, mei: 5,
        jun: 6, juni: 6, june: 6,
        jul: 7, juli: 7, july: 7,
        aug: 8, agu: 8, agust: 8, agustus: 8, august: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, okt: 10, oktober: 10, october: 10,
        nov: 11, november: 11,
        dec: 12, des: 12, desember: 12, december: 12
    };
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];

    // Cocok untuk "18 October 2026" maupun "October 18, 2026"
    const DATE_REGEX = /(\b\d{1,2}\s+[A-Za-z]{3,}\.?,?\s+20\d{2}\b)|(\b[A-Za-z]{3,}\.?\s+\d{1,2},?\s+20\d{2}\b)/;
    const REL_OFFSETS = { 'today': 0, 'hari ini': 0, 'tomorrow': 1, 'besok': 1, 'yesterday': -1, 'kemarin': -1 };

    // Kode kelas seperti IF-49-01, IF-49-REG01, BS1IF-49-REG01
    const CLASS_CODE_SRC = '\\b(?:[A-Z0-9]{0,4})?[A-Z]{2,4}-\\d{2}-(?:[A-Z]{2,4})?\\d{1,2}\\b';
    const CLASS_CODE_TEST = new RegExp(CLASS_CODE_SRC);

    function stripClassCode(text, alsoBrackets = false) {
        let t = (text || '').replace(new RegExp(CLASS_CODE_SRC, 'g'), ' ');
        if (alsoBrackets) t = t.replace(/\[[^\]]*\]/g, ' ');
        return t.replace(/\(\s*\)/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '');
    }

    const pad2 = (n) => String(n).padStart(2, '0');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function showToast(message, isError = false) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed; bottom: 80px; right: 20px; z-index: 1000000;
            max-width: 320px; padding: 12px 16px; border-radius: 8px;
            background: ${isError ? '#D93025' : '#323232'}; color: #fff;
            font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            opacity: 0; transition: opacity 0.3s;`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => (toast.style.opacity = '1'));
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 400);
        }, 4500);
    }

    function extractTime(text) {
        if (!text) return null;
        const m = text.match(/\b(\d{1,2})[:.](\d{2})(\s?[AP]M)?\b/i);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        if (m[3]) {
            const isPM = /pm/i.test(m[3]);
            if (isPM && h < 12) h += 12;
            if (!isPM && h === 12) h = 0;
        }
        if (h > 23) return null;
        return `${pad2(h)}:${m[2]}`;
    }

    // Kunci stabil per aktivitas: tidak berubah walau deadline diubah dosen
    function normalizeUrl(href) {
        try {
            const u = new URL(href, window.location.href);
            if (u.searchParams.has('id')) return `${u.origin}${u.pathname}?id=${u.searchParams.get('id')}`;
            return `${u.origin}${u.pathname}${u.search}`;
        } catch (e) {
            return href;
        }
    }

    // ====================== PARSER TANGGAL ======================
    function parseDeadline(dateStr) {
        if (!dateStr || dateStr === 'Tanpa tenggat waktu') return null;

        // Buang jam supaya tidak terbaca sebagai tanggal
        const s = dateStr.toLowerCase().replace(/\d{1,2}[:.]\d{2}(\s?[ap]m)?/g, ' ');

        const dayMatch = s.match(/\b(\d{1,2})\b/);
        const yearMatch = s.match(/\b(20\d{2})\b/);
        const monthWord = (s.match(/[a-z]+/g) || []).find((w) => MONTHS[w]);

        if (!dayMatch || !monthWord) return null;
        const day = parseInt(dayMatch[1], 10);
        if (day < 1 || day > 31) return null;

        const year = yearMatch ? yearMatch[1] : new Date().getFullYear();
        return `${year}-${pad2(MONTHS[monthWord])}-${pad2(day)}T00:00:00.000Z`;
    }

    // Ubah "Today"/"Tomorrow"/"Hari ini"/"Besok" jadi tanggal nyata; teks tanggal biasa dikembalikan apa adanya
    function resolveHeaderDate(text) {
        const t = text.trim().toLowerCase();
        for (const [word, offset] of Object.entries(REL_OFFSETS)) {
            if (t.startsWith(word)) {
                const d = new Date();
                d.setDate(d.getDate() + offset);
                return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
            }
        }
        return DATE_REGEX.test(text) ? text.trim() : null;
    }

    // Cari header tanggal terdekat SEBELUM item (naik lewat saudara sebelumnya)
    function findDateHeader(item) {
        let node = item;
        while (node && node !== document.body) {
            let sib = node.previousElementSibling;
            while (sib) {
                const headings = sib.matches('h3, h4, h5, h6, [class*="date"]')
                    ? [sib]
                    : Array.from(sib.querySelectorAll('h3, h4, h5, h6, [class*="date"]'));
                for (let i = headings.length - 1; i >= 0; i--) {
                    const text = headings[i].innerText.trim();
                    if (text.length < 80) {
                        const resolved = resolveHeaderDate(text);
                        if (resolved) return resolved;
                    }
                }
                sib = sib.previousElementSibling;
            }
            node = node.parentElement;
        }
        return '';
    }

    // ====================== NAMA MATA KULIAH ======================
    function cleanCourseName(raw) {
        let name = raw || 'Mata Kuliah';
        const splitKeywords = [
            '- Assignment is due', '- Quiz closes',
            'Assignment is due', 'Quiz closes', 'Add submission'
        ];
        for (const kw of splitKeywords) {
            if (name.includes(kw)) name = name.split(kw)[0].trim();
        }
        return name.replace(/[-–—]\s*$/, '').trim() || 'Mata Kuliah';
    }

    function normalizeCourseName(fullName) {
        return stripClassCode(fullName || '', true).toUpperCase()
            .replace(/[\[(][^\])]*[\])]/g, ' ')
            .replace(/\b[A-Z]{2,4}-?\d{2}-?\d{2}\b/g, ' ')
            .replace(/\b\d{4}(\/\d{2,4})?\b/g, ' ')
            .replace(/[-–—_:]+/g, ' ')
            .replace(/\bS1 INFORMATIKA\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Kembalikan singkatan dari COURSE_ALIASES, atau null kalau matkul tidak ada di daftar
    function matchAlias(fullName) {
        const name = normalizeCourseName(fullName);
        const keys = Object.keys(COURSE_ALIASES).sort((a, b) => b.length - a.length);
        for (const k of keys) {
            if (name.includes(k)) return COURSE_ALIASES[k];
        }
        return null;
    }

    function abbreviateCourse(fullName) {
        const raw = fullName || '';
        const isPractice = /\bS1\s+INFORMATIKA\b/i.test(raw) && !CLASS_CODE_TEST.test(raw);
        const base = matchAlias(raw) || normalizeCourseName(raw) || 'MK';
        return isPractice ? `${base} PRAK` : base;
    }

    // Tanda pengenal tugas berdasarkan matkul + judul (bukan URL), supaya tugas dengan nama sama
    // yang dibuat ulang dosen (URL/id berbeda) dianggap tugas yang sama.
    function makeSignature(label, title) {
        const t = (title || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s.,;:!\-–—]+$/g, '').trim();
        return `${(label || '').toUpperCase().trim()}|${t}`;
    }

    function taskSignature(task) {
        return makeSignature(abbreviateCourse(task.course), stripClassCode(task.title) || task.title);
    }

    // Judul di Google Tasks berformat "[HH:MM LABEL] judul"
    function signatureFromGoogleTitle(title) {
        const m = (title || '').match(/^\[\d{2}:\d{2} ([^\]]*)\]\s*(.*)$/);
        return m ? makeSignature(m[1], stripClassCode(m[2]) || m[2]) : null;
    }

    // Moodle menaruh tanggal lengkap di aria-label link, mis. "... is due on 19 October 2026, 6:00 AM"
    function parseAriaDeadline(label) {
        if (!label) return null;
        const m = label.match(/(\d{1,2}\s+[A-Za-z]{3,}\.?,?\s+20\d{2})\s*,?\s*(\d{1,2}[:.]\d{2}(?:\s?[AP]M)?)?\s*$/i);
        if (!m) return null;
        return { date: m[1], time: extractTime(m[2] || '') };
    }

    // ====================== EKSTRAKSI TUGAS ======================
    // Tugas yang dilewati pada ekstraksi terakhir (matkul di luar daftar / kembar di halaman). Dicatat ke log.
    let lastSkipped = [];

    function extractLMSTasks() {
        lastSkipped = [];
        const found = new Map(); // key -> task (dedupe dalam satu halaman)
        const items = document.querySelectorAll('[data-region="event-item"], .timeline-event-list-item');

        items.forEach((item) => {
            const titleElement = item.querySelector('.event-name a, .event-name');
            if (!titleElement) return;
            const linkElement = item.querySelector('.event-name a');

            const courseEl = item.querySelector(
                '.coursename-action span, [class*="coursename"] span, .coursename-action'
            );
            const course = cleanCourseName(courseEl ? courseEl.innerText.trim() : '');

            // Selector jam yang spesifik dulu, baru yang longgar
            const timeEl = item.querySelector('.small-info-text, [data-region="event-time"]')
                || item.querySelector('[class*="time"]');
            const ariaInfo = linkElement ? parseAriaDeadline(linkElement.getAttribute('aria-label')) : null;
            const time = extractTime(timeEl ? timeEl.innerText : '')
                || (ariaInfo && ariaInfo.time) || '23:59';

            const title = titleElement.innerText.trim();
            // Utamakan tanggal dari aria-label; header tanggal hanya cadangan
            const dateStr = (ariaInfo && ariaInfo.date) || findDateHeader(item);
            const deadline = dateStr ? `${dateStr} ${time}` : time;
            const url = linkElement ? linkElement.href : window.location.href;
            const key = linkElement
                ? normalizeUrl(linkElement.href)
                : `lms_${course}_${title}_${dateStr}`.replace(/\s+/g, '_').toLowerCase();

            // Matkul tidak ada di COURSE_ALIASES: lewati (tapi dicatat ke log)
            if (!matchAlias(course)) {
                lastSkipped.push({
                    type: 'filtered', key, title, course, time, deadline, url,
                    note: 'Matkul tidak ada di daftar singkatan (COURSE_ALIASES)'
                });
                return;
            }

            const task = { key, title, course, time, deadline, url, fromTimeline: true };
            const prev = found.get(key);
            // Satu aktivitas bisa punya beberapa event (misal quiz buka/tutup): ambil yang paling akhir
            if (!prev || (parseDeadline(deadline) || '') > (parseDeadline(prev.deadline) || '')) {
                found.set(key, task);
            }
        });

        // Fallback: halaman modul assignment / quiz
        const path = window.location.pathname;
        if (found.size === 0 && (path.includes('/mod/assign/') || path.includes('/mod/quiz/'))) {
            const titleElement = document.querySelector('h1, h2');
            const deadlineRow = Array.from(document.querySelectorAll('tr, div')).find((row) =>
                row.children.length < 4 &&
                /Due date|Batas waktu|Closes/i.test(row.innerText) &&
                DATE_REGEX.test(row.innerText)
            );
            const course = cleanCourseName(
                document.querySelector('.breadcrumb-item:nth-last-child(2)')?.innerText.trim()
            );

            if (titleElement && matchAlias(course)) {
                const deadlineText = deadlineRow
                    ? deadlineRow.innerText.replace(/Due date:?|Batas waktu:?|Closes:?/gi, '').trim()
                    : 'Tanpa tenggat waktu';
                const time = extractTime(deadlineText) || '23:59';
                const key = normalizeUrl(window.location.href);
                found.set(key, {
                    key, title: titleElement.innerText.trim(), course, time,
                    deadline: deadlineText, url: window.location.href
                });
            }
        }

        // Anti-dobel: tugas dengan matkul + judul sama (dosen buat ulang dengan URL berbeda) jadi satu.
        // Yang dipertahankan: tenggat paling akhir; kalau sama, id aktivitas paling baru.
        const idOf = (t) => parseInt((t.key.match(/[?&]id=(\d+)/) || [])[1] || '0', 10);
        const bySig = new Map();
        for (const task of found.values()) {
            const sig = taskSignature(task);
            const prev = bySig.get(sig);
            if (!prev) { bySig.set(sig, task); continue; }
            const a = parseDeadline(task.deadline) || '';
            const b = parseDeadline(prev.deadline) || '';
            const note = 'Kembar di halaman LMS (nama sama dibuat ulang), hanya satu yang dipakai';
            if (a > b || (a === b && idOf(task) > idOf(prev))) {
                bySig.set(sig, task);
                lastSkipped.push({ ...prev, type: 'duplicate', note });
            } else {
                lastSkipped.push({ ...task, type: 'duplicate', note });
            }
        }
        return Array.from(bySig.values());
    }

    // ====================== HTTP ======================
    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...opts,
                timeout: 20000,
                onload: resolve,
                onerror: () => reject({ message: 'Kesalahan jaringan' }),
                ontimeout: () => reject({ message: 'Permintaan timeout' })
            });
        });
    }

    // ====================== TOKEN & LOGIN ======================
    function saveTokens(data) {
        GM_setValue('gTasksAccessToken', data.access_token);
        GM_setValue('gTasksTokenExpiry', Date.now() + (data.expires_in || 3600) * 1000);
        if (data.refresh_token) GM_setValue('gTasksRefreshToken', data.refresh_token);
    }

    function clearTokens() {
        GM_setValue('gTasksAccessToken', null);
        GM_setValue('gTasksTokenExpiry', 0);
        GM_setValue('gTasksRefreshToken', null);
    }

    function accessTokenValid() {
        const token = GM_getValue('gTasksAccessToken', null);
        const expiry = GM_getValue('gTasksTokenExpiry', 0);
        return !!token && Date.now() < expiry - TOKEN_SAFETY_MARGIN_MS;
    }

    function isLoggedIn() {
        return accessTokenValid() || !!GM_getValue('gTasksRefreshToken', null);
    }

    async function getAccessToken(force = false) {
        if (!force && accessTokenValid()) return GM_getValue('gTasksAccessToken');

        const refreshToken = GM_getValue('gTasksRefreshToken', null);
        if (!refreshToken) throw { authFailed: true };

        const form = new URLSearchParams({
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        });
        if (CLIENT_SECRET) form.set('client_secret', CLIENT_SECRET);

        const res = await gmRequest({
            method: 'POST',
            url: TOKEN_URL,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: form.toString()
        });

        if (res.status === 400 || res.status === 401) {
            clearTokens(); // refresh token dicabut / kadaluarsa
            throw { authFailed: true };
        }
        if (res.status !== 200) throw { message: `Refresh token gagal (HTTP ${res.status})` };

        const data = JSON.parse(res.responseText);
        saveTokens(data);
        return data.access_token;
    }

    function base64url(buffer) {
        let s = '';
        new Uint8Array(buffer).forEach((b) => (s += String.fromCharCode(b)));
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    async function startLogin() {
        let authUrl;
        if (USE_CODE_FLOW) {
            const rnd = new Uint8Array(48);
            crypto.getRandomValues(rnd);
            const verifier = base64url(rnd);
            const challenge = base64url(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
            );
            GM_setValue('pkceVerifier', verifier);
            authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT_URI,
                response_type: 'code',
                scope: SCOPES,
                access_type: 'offline',
                prompt: 'consent',
                code_challenge: challenge,
                code_challenge_method: 'S256'
            }).toString();
        } else {
            authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT_URI,
                response_type: 'token',
                scope: SCOPES
            }).toString();
        }
        window.open(authUrl, '_blank');
    }

    async function handleTokenPaste() {
        const input = prompt(
            'Setelah login, kamu akan dilempar ke halaman error (localhost).\n\n' +
            'Copy SELURUH URL di address bar halaman tersebut, lalu paste di bawah ini:'
        );
        if (!input) return;

        let url;
        try {
            url = new URL(input.trim());
        } catch (e) {
            showToast('Format URL tidak valid.', true);
            return;
        }

        const code = url.searchParams.get('code');
        const implicitToken = new URLSearchParams(url.hash.slice(1)).get('access_token');

        try {
            if (code) {
                const form = new URLSearchParams({
                    client_id: CLIENT_ID,
                    code,
                    code_verifier: GM_getValue('pkceVerifier', ''),
                    redirect_uri: REDIRECT_URI,
                    grant_type: 'authorization_code'
                });
                if (CLIENT_SECRET) form.set('client_secret', CLIENT_SECRET);

                const res = await gmRequest({
                    method: 'POST',
                    url: TOKEN_URL,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    data: form.toString()
                });
                if (res.status !== 200) {
                    console.error('[Sync] Tukar kode gagal:', res.responseText);
                    showToast(`Login gagal (HTTP ${res.status}). Cek console.`, true);
                    return;
                }
                saveTokens(JSON.parse(res.responseText));
            } else if (implicitToken) {
                const expiresIn = parseInt(new URLSearchParams(url.hash.slice(1)).get('expires_in') || '3600', 10);
                saveTokens({ access_token: implicitToken, expires_in: expiresIn });
            } else {
                showToast('URL tidak mengandung code atau access_token. Copy seluruh URL.', true);
                return;
            }
            showToast('Login berhasil.');
            refreshLoginUI();
            if (IS_BERANDA) berandaSync(true);
            else processSync(true);
        } catch (e) {
            console.error('[Sync] Login error:', e);
            showToast('Login gagal. Cek console.', true);
        }
    }

    // ====================== GOOGLE TASKS API ======================
    async function tasksApi(method, path, body, retry = 0, refreshed = false) {
        const token = await getAccessToken();
        const res = await gmRequest({
            method,
            url: TASKS_BASE + path,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: body ? JSON.stringify(body) : undefined
        });

        if (res.status === 401) {
            if (!refreshed && GM_getValue('gTasksRefreshToken', null)) {
                await getAccessToken(true);
                return tasksApi(method, path, body, retry, true);
            }
            throw { authFailed: true };
        }
        if ((res.status === 429 || res.status >= 500) && retry < 3) {
            await sleep(1000 * Math.pow(2, retry));
            return tasksApi(method, path, body, retry + 1, refreshed);
        }
        if (res.status < 200 || res.status >= 300) {
            throw { message: `HTTP ${res.status}`, detail: res.responseText };
        }
        return res.responseText ? JSON.parse(res.responseText) : {};
    }

    // Format baru: hanya baris "URL: ...". Format lama: ada baris "LMS-KEY: ..." terpisah.
    function parseKeyFromNotes(notes) {
        const n = notes || '';
        const k = n.match(/^LMS-KEY: (.+)$/m);
        if (k) return k[1].trim();
        const u = n.match(/^URL: (\S+)/m);
        return u ? normalizeUrl(u[1]) : null;
    }

    async function fetchExistingTasks() {
        const byKey = new Map(); // LMS-KEY -> task Google
        const bySig = new Map(); // matkul|judul -> task Google (menangkap tugas yang dibuat ulang dosen)
        let pageToken = '';
        let pages = 0;
        do {
            const q = '?maxResults=100&showCompleted=true&showHidden=true' +
                (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
            const data = await tasksApi('GET', '/lists/@default/tasks' + q);
            (data.items || []).forEach((t) => {
                const key = parseKeyFromNotes(t.notes);
                if (key) byKey.set(key, t);
                const sig = signatureFromGoogleTitle(t.title);
                if (sig) {
                    const prev = bySig.get(sig);
                    // Kalau sudah ada kembar di Google, pilih yang belum selesai
                    if (!prev || (prev.status === 'completed' && t.status !== 'completed')) bySig.set(sig, t);
                }
            });
            pageToken = data.nextPageToken || '';
            pages++;
        } while (pageToken && pages < 20);
        return { byKey, bySig };
    }

    function buildPayload(task) {
        const isUrlKey = /^https?:\/\//.test(task.key);
        const cleanTitle = stripClassCode(task.title) || task.title;
        const payload = {
            title: `[${task.time} ${abbreviateCourse(task.course)}] ${cleanTitle}`,
            notes:
                `Mata kuliah: ${stripClassCode(task.course, true) || task.course}\n` +
                `Diimpor dari LMS Telkom University.\n` +
                `Deadline LMS: ${task.deadline}\n` +
                // Satu URL saja. Kalau kuncinya bukan URL, simpan terpisah supaya tetap bisa dikenali.
                (isUrlKey ? `URL: ${task.key}` : `URL: ${task.url}\nLMS-KEY: ${task.key}`)
        };
        const due = parseDeadline(task.deadline);
        if (due) payload.due = due;
        return payload;
    }

    // Update hanya kalau tanggal atau jam deadline berubah
    function needsUpdate(existing, payload, task) {
        const timeOf = (title) => ((title || '').match(/^\[(\d{2}:\d{2})/) || [])[1] || '';
        const dueChanged = payload.due && (existing.due || '').slice(0, 10) !== payload.due.slice(0, 10);
        const timeChanged = timeOf(existing.title) !== timeOf(payload.title);
        // Label mata kuliah berubah (mis. alias diganti / praktikum terdeteksi). Hanya dicek dari timeline
        // supaya halaman modul dengan nama course berbeda tidak membuat judul bolak-balik.
        const labelOf = (title) => ((title || '').match(/^\[\d{2}:\d{2} ([^\]]*)\]/) || [])[1] || '';
        const labelChanged = !!(task && task.fromTimeline) && labelOf(existing.title) !== labelOf(payload.title);
        // Migrasi sekali: task lama yang judulnya masih memuat kode kelas atau notes-nya punya URL ganda
        const legacyNotes = /^LMS-KEY: /m.test(existing.notes || '') && !/^LMS-KEY: /m.test(payload.notes);
        const legacyTitle = CLASS_CODE_TEST.test(existing.title || '');
        return !!(dueChanged || timeChanged || labelChanged || legacyNotes || legacyTitle);
    }

    // ====================== LOCK ANTAR TAB ======================
    function acquireLock() {
        const t = GM_getValue('syncLock', 0);
        if (t && Date.now() - t < LOCK_TTL_MS) return false;
        GM_setValue('syncLock', Date.now());
        return true;
    }
    function releaseLock() {
        GM_setValue('syncLock', 0);
    }

    // Google Tasks menaruh task baru di paling atas ("My order"), jadi task dengan tenggat
    // terdekat harus dibuat PALING AKHIR. Urutan buat: tenggat terjauh -> terdekat.
    function deadlineSortKey(task) {
        const date = (parseDeadline(task.deadline) || '9999-12-31').slice(0, 10); // tanpa tanggal = paling jauh
        return `${date} ${task.time || '23:59'}`;
    }

    // ====================== LOG (bisa dilihat lewat menu 📋 Lihat log) ======================
    // Tiga daftar disimpan di storage userscript:
    //   syncedInfo : semua tugas yang pernah dikirim/dikenali (dipakai untuk mendeteksi yang dihapus)
    //   deletedLog : tugas yang pernah dikirim tapi sudah tidak ada di Google Tasks
    //   skipLog    : tugas yang dilewati (duplikat / matkul di luar daftar singkatan)
    function pruneLog(obj) {
        const entries = Object.entries(obj);
        if (entries.length <= MAX_LOG) return obj;
        entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
        return Object.fromEntries(entries.slice(0, MAX_LOG));
    }

    // Baca-ubah-tulis sinkron supaya tidak bentrok dengan tab lain
    function logUpdate(name, fn) {
        const data = GM_getValue(name, {}) || {};
        fn(data);
        GM_setValue(name, pruneLog(data));
    }

    function taskRecord(task, extra) {
        return Object.assign({
            key: task.key, title: task.title, course: task.course, time: task.time,
            deadline: task.deadline, url: task.url, at: Date.now()
        }, extra || {});
    }

    function recordSkipped(skipped) {
        if (!skipped || !skipped.length) return;
        logUpdate('skipLog', (log) => {
            for (const s of skipped) {
                const id = `${s.type}|${s.key}`;
                if (!log[id]) log[id] = taskRecord(s, { type: s.type, note: s.note || '' });
            }
        });
    }

    function recordDeleted(task) {
        const sig = taskSignature(task);
        logUpdate('deletedLog', (log) => {
            if (!log[sig]) log[sig] = taskRecord(task, { sig });
        });
    }

    // Tugas yang sudah ada di Google Tasks: simpan datanya, dan hapus dari daftar "dihapus" kalau ada
    function rememberSynced(task) {
        const sig = taskSignature(task);
        logUpdate('syncedInfo', (info) => { info[sig] = taskRecord(task, { sig }); });
        logUpdate('deletedLog', (log) => { delete log[sig]; });
        logUpdate('skipLog', (log) => { delete log[`filtered|${task.key}`]; });
    }

    // Bandingkan tugas yang pernah dikirim dengan isi Google Tasks sekarang
    function detectDeleted(existing) {
        const info = GM_getValue('syncedInfo', {}) || {};
        logUpdate('deletedLog', (log) => {
            for (const [sig, t] of Object.entries(info)) {
                if (existing.bySig.has(sig) || existing.byKey.has(t.key)) {
                    delete log[sig]; // ada lagi (dipulihkan)
                } else if (!log[sig]) {
                    log[sig] = Object.assign({}, t, { sig, at: Date.now() });
                }
            }
        });
    }

    function getLogEntries(store, type) {
        const data = GM_getValue(store, {}) || {};
        return Object.entries(data)
            .filter(([, v]) => !type || v.type === type)
            .map(([id, v]) => Object.assign({}, v, { id }))
            .sort((a, b) => (b.at || 0) - (a.at || 0));
    }

    // Kirim ulang tugas yang tadi dihapus di Google Tasks
    async function restoreDeleted(sig) {
        const rec = (GM_getValue('deletedLog', {}) || {})[sig];
        if (!rec) return false;
        if (!isLoggedIn()) {
            showToast('Login Google dulu.', true);
            return false;
        }
        try {
            await tasksApi('POST', '/lists/@default/tasks', buildPayload(rec));
            const history = new Set(GM_getValue('syncedKeys', []));
            history.add(rec.key);
            history.add(`sig:${sig}`);
            GM_setValue('syncedKeys', Array.from(history).slice(-MAX_HISTORY));
            logUpdate('deletedLog', (log) => { delete log[sig]; });
            showToast('Tugas dikirim ulang ke Google Tasks.');
            return true;
        } catch (err) {
            if (err && err.authFailed) {
                clearTokens();
                refreshLoginUI();
                showToast('Sesi Google habis. Silakan login ulang lewat tombol di pojok kanan bawah.', true);
            } else {
                showToast(`Gagal mengirim ulang: ${(err && err.message) || 'kesalahan tak dikenal'}`, true);
            }
            return false;
        }
    }

    // ====================== PROSES SYNC (LMS -> GOOGLE TASKS) ======================
    let syncing = false;

    async function processSync(isAuto = false) {
        if (syncing) return;

        if (!isLoggedIn()) {
            if (!isAuto) showToast('Belum login. Pakai tombol login di pojok kanan bawah.', true);
            refreshLoginUI();
            return;
        }

        const tasks = extractLMSTasks();
        recordSkipped(lastSkipped.slice());
        if (tasks.length === 0) {
            if (!isAuto) showToast('Tidak ada tugas (dari matkul di daftar singkatan) yang terdeteksi di halaman ini.');
            return;
        }
        // Terjauh dulu, terdekat terakhir (supaya yang terdekat tampil paling atas)
        tasks.sort((a, b) => deadlineSortKey(b).localeCompare(deadlineSortKey(a)));

        if (!acquireLock()) {
            if (!isAuto) showToast('Sinkronisasi sedang berjalan di tab lain.');
            return;
        }
        syncing = true;

        let added = 0, updated = 0, failed = 0;
        try {
            const existing = await fetchExistingTasks();
            detectDeleted(existing);
            const history = new Set(GM_getValue('syncedKeys', []));

            for (const task of tasks) {
                const payload = buildPayload(task);
                const sigKey = 'sig:' + taskSignature(task);
                // Cocokkan lewat URL dulu, lalu lewat matkul+judul (tugas yang dibuat ulang dosen)
                const current = existing.byKey.get(task.key) || existing.bySig.get(taskSignature(task));
                try {
                    if (current) {
                        if (current.status !== 'completed' && needsUpdate(current, payload, task)) {
                            await tasksApi('PATCH', `/lists/@default/tasks/${current.id}`, payload);
                            updated++;
                        }
                        history.add(task.key);
                        history.add(sigKey);
                        rememberSynced(task);
                        if (!existing.byKey.has(task.key)) {
                            recordSkipped([{
                                ...task, type: 'duplicate',
                                note: 'Sudah ada di Google Tasks dengan nama sama (URL berbeda), tidak dibuat lagi'
                            }]);
                        }
                    } else if (history.has(task.key) || history.has(sigKey)) {
                        recordDeleted(task);
                        continue; // pernah dikirim, sekarang tidak ada di Google = sengaja dihapus user
                    } else {
                        const created = await tasksApi('POST', '/lists/@default/tasks', payload);
                        existing.bySig.set(taskSignature(task), created);
                        history.add(task.key);
                        history.add(sigKey);
                        rememberSynced(task);
                        added++;
                    }
                } catch (err) {
                    if (err && err.authFailed) throw err;
                    failed++;
                    console.error('[Sync] Gagal:', task.title, err);
                }
            }

            GM_setValue('syncedKeys', Array.from(history).slice(-MAX_HISTORY));

            if (added || updated) {
                const parts = [];
                if (added) parts.push(`${added} tugas baru`);
                if (updated) parts.push(`${updated} deadline diperbarui`);
                showToast(`Berhasil: ${parts.join(', ')}.`);
            } else if (failed) {
                showToast(`${failed} tugas gagal disinkronkan. Cek console.`, true);
            } else if (!isAuto) {
                showToast('Semua tugas di halaman ini sudah tersimpan.');
            }
        } catch (err) {
            if (err && err.authFailed) {
                clearTokens();
                refreshLoginUI();
                showToast('Sesi Google habis. Silakan login ulang lewat tombol di pojok kanan bawah.', true);
            } else {
                console.error('[Sync] Error:', err);
                showToast(`Sinkronisasi gagal: ${(err && err.message) || 'kesalahan tak dikenal'}`, true);
            }
        } finally {
            syncing = false;
            releaseLock();
        }
    }

    function resetSyncHistory() {
        const count = GM_getValue('syncedKeys', []).length;
        const ok = confirm(
            `Riwayat ${count} tugas akan dihapus. Tugas yang masih ada di Google Tasks tidak akan dobel, ` +
            'tetapi tugas yang pernah kamu hapus di Google Tasks akan dikirim ulang.\n\nLanjutkan?'
        );
        if (!ok) return;
        GM_setValue('syncedKeys', []);
        showToast('Riwayat direset. Menyinkronkan ulang...');
        processSync(false);
    }

    function logout() {
        clearTokens();
        showToast('Berhasil keluar dari Google.');
        refreshLoginUI();
    }

    // ====================== PANEL LOG ======================
    const LOG_TABS = [
        {
            id: 'deleted', label: 'Dihapus', store: 'deletedLog', type: null,
            hint: 'Pernah dikirim ke Google Tasks tapi sekarang sudah tidak ada. Tidak dikirim ulang otomatis.',
            empty: 'Belum ada tugas yang terdeteksi dihapus dari Google Tasks.'
        },
        {
            id: 'duplicate', label: 'Duplikat', store: 'skipLog', type: 'duplicate',
            hint: 'Tugas kembar (matkul + judul sama) yang tidak dibuat lagi.',
            empty: 'Belum ada duplikat yang dilewati.'
        },
        {
            id: 'filtered', label: 'Matkul dilewati', store: 'skipLog', type: 'filtered',
            hint: 'Tugas dari matkul yang tidak ada di daftar singkatan, jadi tidak dikirim.',
            empty: 'Belum ada tugas dari matkul lain yang dilewati.'
        }
    ];

    function el(tag, css, text) {
        const e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function logButtonStyle(bg, color) {
        return `padding: 6px 12px; background: ${bg}; color: ${color}; border: none; border-radius: 16px;
                cursor: pointer; font-size: 12px; font-weight: 600;`;
    }

    function buildLogItem(item, tab, rerender) {
        const row = el('div', 'padding: 10px 16px; border-bottom: 1px solid #eee;');
        row.appendChild(el('div', 'font-weight: 600; font-size: 14px; word-break: break-word;', item.title || '(tanpa judul)'));

        const meta = [
            item.course ? (stripClassCode(item.course, true) || item.course) : '',
            item.deadline ? `Deadline: ${item.deadline}` : '',
            `Dicatat: ${new Date(item.at || Date.now()).toLocaleString('id-ID')}`
        ].filter(Boolean).join(' • ');
        row.appendChild(el('div', 'font-size: 12px; color: #5f6368; margin-top: 2px;', meta));
        if (item.note) row.appendChild(el('div', 'font-size: 12px; color: #5f6368; margin-top: 2px;', item.note));

        const actions = el('div', 'margin-top: 6px; display: flex; gap: 8px; align-items: center;');
        if (item.url && /^https?:\/\//.test(item.url)) {
            const a = el('a', 'font-size: 12px; color: #1a73e8; text-decoration: none;', 'Buka di LMS');
            a.href = item.url;
            a.target = '_blank';
            a.rel = 'noopener';
            actions.appendChild(a);
        }
        if (tab.id === 'deleted') {
            const btn = el('button', logButtonStyle('#0F9D58', 'white'), 'Kirim ulang');
            btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = 'Mengirim...';
                const ok = await restoreDeleted(item.id);
                if (ok) rerender();
                else { btn.disabled = false; btn.textContent = 'Kirim ulang'; }
            };
            actions.appendChild(btn);
        }
        row.appendChild(actions);
        return row;
    }

    function openLogPanel(activeId = 'deleted') {
        document.getElementById('gtasks-log-overlay')?.remove();

        const overlay = el('div',
            'position: fixed; inset: 0; z-index: 1000001; background: rgba(0,0,0,0.45); display: flex; ' +
            'align-items: center; justify-content: center; font-family: system-ui, sans-serif;');
        overlay.id = 'gtasks-log-overlay';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        const card = el('div',
            'background: #fff; color: #202124; width: min(560px, 94vw); max-height: 80vh; border-radius: 12px; ' +
            'box-shadow: 0 8px 32px rgba(0,0,0,0.35); display: flex; flex-direction: column; overflow: hidden;');

        const header = el('div', 'display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #eee;');
        header.appendChild(el('div', 'font-size: 16px; font-weight: 700;', '📋 Log Sinkronisasi'));
        const closeBtn = el('button', 'border: none; background: transparent; font-size: 20px; cursor: pointer; color: #5f6368;', '✕');
        closeBtn.onclick = () => overlay.remove();
        header.appendChild(closeBtn);

        const tabsRow = el('div', 'display: flex; gap: 6px; padding: 10px 16px 0; flex-wrap: wrap;');
        const hint = el('div', 'font-size: 12px; color: #5f6368; padding: 8px 16px;');
        const list = el('div', 'overflow-y: auto; flex: 1; min-height: 120px;');
        const footer = el('div', 'display: flex; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid #eee;');
        const clearBtn = el('button', logButtonStyle('#757575', 'white'), 'Bersihkan daftar ini');
        footer.appendChild(clearBtn);

        let active = activeId;
        const currentTab = () => LOG_TABS.find((t) => t.id === active) || LOG_TABS[0];

        const render = () => {
            const tab = currentTab();
            tabsRow.replaceChildren();
            LOG_TABS.forEach((t) => {
                const count = getLogEntries(t.store, t.type).length;
                const on = t.id === tab.id;
                const b = el('button', logButtonStyle(on ? '#1a73e8' : '#e8eaed', on ? 'white' : '#202124'), `${t.label} (${count})`);
                b.onclick = () => { active = t.id; render(); };
                tabsRow.appendChild(b);
            });
            hint.textContent = tab.hint;

            list.replaceChildren();
            const items = getLogEntries(tab.store, tab.type);
            if (!items.length) {
                list.appendChild(el('div', 'padding: 28px 16px; text-align: center; color: #757575; font-size: 13px;', tab.empty));
            } else {
                items.forEach((item) => list.appendChild(buildLogItem(item, tab, render)));
            }
            // Daftar "Dihapus" sengaja tidak bisa dibersihkan, supaya tugas yang dihapus tidak muncul lagi tanpa jejak
            footer.style.display = tab.id === 'deleted' ? 'none' : 'flex';
        };

        clearBtn.onclick = () => {
            const tab = currentTab();
            if (!confirm(`Bersihkan daftar "${tab.label}"? Daftar akan terisi lagi kalau tugasnya terdeteksi lagi.`)) return;
            logUpdate(tab.store, (log) => {
                for (const [id, v] of Object.entries(log)) {
                    if (!tab.type || v.type === tab.type) delete log[id];
                }
            });
            render();
        };

        card.append(header, tabsRow, hint, list, footer);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        render();
    }

    // ====================== TOMBOL LOGIN (hanya muncul kalau belum login) ======================
    function buttonStyle(bg, color) {
        return `padding: 12px 18px; background: ${bg}; color: ${color}; border: none; border-radius: 8px;
                cursor: pointer; font-weight: bold; box-shadow: 0 4px 12px rgba(0,0,0,0.2);`;
    }

    function buildLoginUI() {
        const container = document.createElement('div');
        container.id = 'gtasks-login-container';
        container.style.cssText =
            'position: fixed; bottom: 20px; right: 20px; z-index: 999999; display: flex; flex-direction: column; gap: 10px; align-items: flex-end;';

        const authBtn = document.createElement('button');
        authBtn.textContent = '1️⃣ Buka Halaman Login Google';
        authBtn.style.cssText = buttonStyle('#4285F4', 'white');
        authBtn.onclick = startLogin;

        const pasteBtn = document.createElement('button');
        pasteBtn.textContent = '2️⃣ Paste URL Hasil Login';
        pasteBtn.style.cssText = buttonStyle('#FBBC05', 'black');
        pasteBtn.onclick = handleTokenPaste;

        container.append(authBtn, pasteBtn);
        return container;
    }

    // Tampilkan tombol login kalau belum login, sembunyikan kalau sudah
    function refreshLoginUI() {
        document.getElementById('gtasks-login-container')?.remove();
        if (!isLoggedIn()) document.body.appendChild(buildLoginUI());
    }

    // ====================== MENU EKSTENSI ======================
    // Sync, log, reset, dan logout ada di menu ikon Tampermonkey.
    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        // Halaman beranda: menu sederhana
        if (IS_BERANDA) {
            GM_registerMenuCommand('🔄 Sync tugas sekarang', () => berandaSync(true));
            GM_registerMenuCommand('🚪 Keluar dari Google', logout);
            return;
        }

        const deletedCount = Object.keys(GM_getValue('deletedLog', {}) || {}).length;
        const needLogin = () => {
            refreshLoginUI();
            showToast('Belum login. Pakai tombol login di pojok kanan bawah.', true);
        };

        GM_registerMenuCommand('🔄 Sync sekarang', () => (isLoggedIn() ? processSync(false) : needLogin()));
        GM_registerMenuCommand(
            deletedCount ? `📋 Lihat log (${deletedCount} dihapus)` : '📋 Lihat log',
            () => openLogPanel()
        );
        GM_registerMenuCommand('🗑️ Reset riwayat sinkronisasi', resetSyncHistory);
        GM_registerMenuCommand('🚪 Keluar dari Google', logout);
    }

    // ====================== AUTO-SYNC (LMS) ======================
    function isAutoSyncPage() {
        const path = window.location.pathname;
        return (
            path === '/' || path.startsWith('/my') || path.startsWith('/calendar') ||
            path.includes('/mod/assign/') || path.includes('/mod/quiz/')
        );
    }

    // Timeline Moodle dimuat via AJAX: tunggu sampai item muncul (maks ~12 detik)
    function autoSyncWhenReady(attempt = 0) {
        if (extractLMSTasks().length > 0) {
            processSync(true);
        } else if (attempt < 8) {
            setTimeout(() => autoSyncWhenReady(attempt + 1), 1500);
        }
    }

    // ====================== BERANDA: SINKRON DUA ARAH DENGAN GOOGLE TASKS ======================
    const B_KEY = 'beranda.tasks';
    const B_POLL_MS = 60 * 1000;                       // tarik data tiap 60 detik (hanya saat tab terlihat)
    const B_MIN_GAP_MS = 15 * 1000;                    // jarak minimal antar tarikan
    const B_KEEP_COMPLETED_MS = 7 * 24 * 3600 * 1000;  // tugas selesai lebih lama dari ini tidak ditampilkan
    const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

    function bLoad() {
        try { return JSON.parse(localStorage.getItem(B_KEY)) || []; } catch (e) { return []; }
    }
    function bSave(tasks) {
        localStorage.setItem(B_KEY, JSON.stringify(tasks));
    }
    function bNotify() {
        window.dispatchEvent(new Event('beranda:tasks-updated'));
    }
    // Status sinkron dibaca halaman beranda lewat atribut di <html>
    function bStatus(state, msg) {
        document.documentElement.setAttribute('data-beranda-sync', state);
        document.documentElement.setAttribute('data-beranda-msg', msg || '');
        window.dispatchEvent(new Event('beranda:status'));
    }
    const bClock = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

    // Task Google -> bentuk yang dipakai halaman beranda
    function bFromGoogle(g) {
        const m = (g.title || '').match(/^\[(\d{2}:\d{2}) ([^\]]*)\]\s*(.*)$/);
        const due = g.due ? g.due.slice(0, 10) : '';
        let dateText = '';
        if (due) {
            const [y, mo, d] = due.split('-');
            dateText = `${parseInt(d, 10)} ${SHORT_MONTHS[parseInt(mo, 10) - 1]} ${y}`;
        }
        let title = g.title || '(tanpa judul)';
        let date = dateText || 'Google Tasks';
        let time = '';
        if (m) {
            time = m[1];
            title = m[3] || title;
            date = `${m[2]} · ${dateText ? dateText + ', ' : ''}${m[1]}`;
        }
        return {
            title, date, time, due, gid: g.id,
            status: g.status === 'completed' ? 'completed' : 'pending'
        };
    }

    function bSortKey(t) {
        if (t.status === 'completed') return '2';
        if (!t.due) return '1';
        return `0 ${t.due} ${t.time || '23:59'}`;
    }

    function bKeep(g) {
        if (!(g.title || '').trim()) return false;
        if (g.status !== 'completed') return true;
        const doneAt = Date.parse(g.completed || g.updated || '') || 0;
        return Date.now() - doneAt < B_KEEP_COMPLETED_MS;
    }

    async function bFetchGoogle() {
        const out = [];
        let pageToken = '';
        let pages = 0;
        do {
            const q = '?maxResults=100&showCompleted=true&showHidden=false' +
                (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
            const data = await tasksApi('GET', '/lists/@default/tasks' + q);
            out.push(...(data.items || []));
            pageToken = data.nextPageToken || '';
            pages++;
        } while (pageToken && pages < 20);
        return out;
    }

    // Halaman -> Google: kirim perubahan lokal (hapus, tambah, centang)
    // "bSnap" = status terakhir yang sudah cocok dengan Google; selisihnya = perubahan lokal.
    async function bPush() {
        const snap = GM_getValue('bSnap', {}) || {};
        const del = new Set(GM_getValue('bDel', []));
        const local = bLoad();
        const localIds = new Set(local.filter((t) => t.gid).map((t) => t.gid));
        for (const gid of Object.keys(snap)) if (!localIds.has(gid)) del.add(gid);

        const isGone = (err) => /HTTP (404|410)/.test((err && err.message) || '');

        // 1. Hapus
        for (const gid of Array.from(del)) {
            try {
                await tasksApi('DELETE', `/lists/@default/tasks/${gid}`);
                del.delete(gid); delete snap[gid];
            } catch (err) {
                if (err && err.authFailed) throw err;
                if (isGone(err)) { del.delete(gid); delete snap[gid]; }
                else console.error('[Beranda] Gagal hapus:', gid, err);
            }
        }

        // 2. Tambah (tugas manual yang belum punya gid)
        const assigned = [];
        for (const t of local) {
            if (t.gid) continue;
            try {
                const created = await tasksApi('POST', '/lists/@default/tasks', { title: t.title });
                assigned.push({ title: t.title, gid: created.id });
                snap[created.id] = 'pending';
            } catch (err) {
                if (err && err.authFailed) throw err;
                console.error('[Beranda] Gagal tambah:', t.title, err);
            }
        }

        // Baca ulang storage (user mungkin mengubah sesuatu selagi menunggu jaringan), lalu pasang gid
        const fresh = bLoad();
        for (const a of assigned) {
            const f = fresh.find((x) => !x.gid && x.title === a.title);
            if (f) f.gid = a.gid; else del.add(a.gid); // sudah dihapus user sebelum sempat dikirim
        }
        if (assigned.length) bSave(fresh);

        // 3. Status centang
        for (const t of fresh) {
            if (!t.gid || snap[t.gid] === t.status) continue;
            try {
                await tasksApi('PATCH', `/lists/@default/tasks/${t.gid}`,
                    t.status === 'completed'
                        ? { status: 'completed' }
                        : { status: 'needsAction', completed: null });
                snap[t.gid] = t.status;
            } catch (err) {
                if (err && err.authFailed) throw err;
                if (isGone(err)) delete snap[t.gid];
                else console.error('[Beranda] Gagal ubah status:', t.title, err);
            }
        }

        GM_setValue('bSnap', snap);
        GM_setValue('bDel', Array.from(del));
    }

    // Google -> halaman: tarik semua tugas lalu gabungkan dengan data lokal
    async function bPull() {
        const items = (await bFetchGoogle()).filter(bKeep);
        const byId = new Map(items.map((g) => [g.id, g]));
        const pendingDel = new Set(GM_getValue('bDel', []));

        const next = [];
        const seen = new Set();
        for (const t of bLoad()) {
            if (!t.gid) { next.push(t); continue; }   // belum terkirim, biarkan
            const g = byId.get(t.gid);
            if (!g) continue;                          // sudah dihapus / lama selesai di Google
            const f = bFromGoogle(g);
            if (t.date === 'Manual') f.date = 'Manual';
            next.push(Object.assign({}, t, f));
            seen.add(t.gid);
        }
        for (const g of byId.values()) {
            if (seen.has(g.id) || pendingDel.has(g.id)) continue;
            next.push(bFromGoogle(g));
        }
        next.sort((a, b) => bSortKey(a).localeCompare(bSortKey(b)));

        bSave(next);
        const snap = {};
        next.forEach((t) => { if (t.gid) snap[t.gid] = t.status; });
        GM_setValue('bSnap', snap);
        bNotify();
    }

    // Semua operasi diantre supaya tidak saling tabrakan
    let bChain = Promise.resolve();
    let bLastPull = 0;

    function bRun(fn, manual) {
        bChain = bChain.then(async () => {
            if (!isLoggedIn()) {
                bStatus('login', 'Belum login Google. Pakai tombol login di pojok kanan bawah.');
                if (manual) { refreshLoginUI(); showToast('Belum login. Pakai tombol login di pojok kanan bawah.', true); }
                return;
            }
            try {
                bStatus('syncing');
                await fn();
                bStatus('ok', bClock());
                if (manual) showToast('Tugas disinkronkan dengan Google Tasks.');
            } catch (err) {
                if (err && err.authFailed) {
                    clearTokens();
                    refreshLoginUI();
                    bStatus('login', 'Sesi Google habis. Login ulang lewat tombol di pojok kanan bawah.');
                    showToast('Sesi Google habis. Silakan login ulang.', true);
                } else {
                    console.error('[Beranda] Sync error:', err);
                    bStatus('error', `Sinkronisasi gagal: ${(err && err.message) || 'kesalahan tak dikenal'}`);
                    if (manual) showToast(`Sinkronisasi gagal: ${(err && err.message) || 'kesalahan tak dikenal'}`, true);
                }
            }
        });
        return bChain;
    }

    function berandaSync(manual) {
        bLastPull = Date.now();
        return bRun(async () => { await bPush(); await bPull(); }, manual);
    }

    function initBeranda() {
        bStatus(isLoggedIn() ? 'syncing' : 'login', isLoggedIn() ? '' : 'Belum login Google. Pakai tombol login di pojok kanan bawah.');
        window.addEventListener('beranda:request-sync', () => berandaSync(true));
        // Perubahan dari halaman -> langsung dikirim (didebounce supaya klik beruntun jadi satu kali)
        let timer = null;
        window.addEventListener('beranda:tasks-changed', () => {
            clearTimeout(timer);
            timer = setTimeout(() => bRun(bPush, false), 400);
        });

        // Tarik data saat tab kembali terlihat, dan berkala selama terlihat
        const maybePull = () => {
            if (document.visibilityState !== 'visible') return;
            if (Date.now() - bLastPull < B_MIN_GAP_MS) return;
            berandaSync(false);
        };
        document.addEventListener('visibilitychange', maybePull);
        setInterval(maybePull, B_POLL_MS);

        if (isLoggedIn()) berandaSync(false);
    }

    // ====================== INIT ======================
    let initialized = false;

    function init() {
        if (initialized) return;
        initialized = true;
        registerMenu();
        refreshLoginUI();

        if (IS_BERANDA) {
            initBeranda();
            return;
        }

        if (isLoggedIn() && isAutoSyncPage()) {
            setTimeout(() => autoSyncWhenReady(), 2000);
        }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 1500);
    } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500), { once: true });
    }
})();
