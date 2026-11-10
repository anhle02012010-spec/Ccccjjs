// ==UserScript==
// @name         Agma.io Auto Farm XP - Modern Blue UI
// @namespace    http://tampermonkey.net/
// @version      7.1.0
// @description  Auto Farm XP chạy ngầm bằng Worker, giao diện Xanh Dương, tự bỏ qua hướng 0 giây
// @author       Custom Blue Edition
// @match        *://agma.io/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    const myWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    let running = false;
    let orientation = "none";
    let currentStep = 0;
    let map = { width: 0, height: 0 };
    let activeSocket = null;
    let isMinimized = false;

    // Biến phục vụ bộ đếm ngược
    let stepStartTime = 0;
    let stepDuration = 0;

    // --- WEB WORKER: CHẠY NGẦM KHÔNG BỊ TRÌNH DUYỆT BÓP THỜI GIAN ---
    const workerScript = `
        let moveInterval = null;
        let stepTimer = null;
        let splitTimer = null;
        let respawnTimer = null;

        self.onmessage = function (e) {
            const data = e.data;

            if (data.action === 'start') {
                if (moveInterval) clearInterval(moveInterval);
                moveInterval = setInterval(() => self.postMessage('tick'), 80);

                if (splitTimer) clearInterval(splitTimer);
                const st = data.splitTime || 4000;
                splitTimer = setInterval(() => self.postMessage('triggerSplit'), st);

                if (respawnTimer) clearInterval(respawnTimer);
                respawnTimer = setInterval(() => self.postMessage('triggerRespawn'), 1500);

            } else if (data.action === 'updateSplit') {
                if (splitTimer) clearInterval(splitTimer);
                const st = data.splitTime || 4000;
                splitTimer = setInterval(() => self.postMessage('triggerSplit'), st);

            } else if (data.action === 'stop') {
                if (moveInterval) clearInterval(moveInterval);
                if (stepTimer) clearTimeout(stepTimer);
                if (splitTimer) clearInterval(splitTimer);
                if (respawnTimer) clearInterval(respawnTimer);

            } else if (data.action === 'nextStep') {
                if (stepTimer) clearTimeout(stepTimer);
                stepTimer = setTimeout(() => {
                    self.postMessage('changeDirection');
                }, data.duration);
            }
        };
    `;

    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    worker.onmessage = function (e) {
        if (!running) return;
        const msg = e.data;

        if (msg === 'tick') {
            if (document.hidden) {
                sendMovePacketDirect();
            } else {
                updateCountdownUI();
            }
        } else if (msg === 'changeDirection') {
            currentStep = (currentStep + 1) % 4;
            runMovementLoop();
        } else if (msg === 'triggerSplit') {
            const chk = document.getElementById('autoSpamCheck');
            if (chk && chk.checked) sendSplitPacket();
        } else if (msg === 'triggerRespawn') {
            const chk = document.getElementById('autoRespawnCheck');
            if (chk && chk.checked) checkAndRespawn();
        }
    };

    // --- BẮT VÀ LƯU WEBSOCKET ---
    const WebSocketProto = (typeof myWin.WebSocket !== 'undefined') ? myWin.WebSocket.prototype : WebSocket.prototype;
    const sendMethod = WebSocketProto.send;

    WebSocketProto.send = function () {
        activeSocket = this;
        let data = arguments[0];

        if (running && orientation !== "none" && data instanceof DataView && data.byteLength >= 9 && data.getUint8(0) === 0) {
            let moveX = orientation === "right" ? 1e7 : orientation === "left" ? -1e7 : 0;
            let moveY = orientation === "bottom" ? 1e7 : orientation === "top" ? -1e7 : 0;
            data.setUint32(1, moveX, true);
            data.setUint32(5, moveY, true);
        }
        return sendMethod.apply(this, arguments);
    };

    function sendMovePacketDirect() {
        if (activeSocket && activeSocket.readyState === WebSocket.OPEN && running && orientation !== "none") {
            let moveX = orientation === "right" ? 1e7 : orientation === "left" ? -1e7 : 0;
            let moveY = orientation === "bottom" ? 1e7 : orientation === "top" ? -1e7 : 0;

            const buf = new ArrayBuffer(9);
            const view = new DataView(buf);
            view.setUint8(0, 0);
            view.setUint32(1, moveX, true);
            view.setUint32(5, moveY, true);
            sendMethod.call(activeSocket, buf);
        }
    }

    // --- AUTO SPLIT ---
    function sendSplitPacket() {
        const evData = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
        ['keydown', 'keyup'].forEach(type => {
            myWin.dispatchEvent(new KeyboardEvent(type, evData));
            document.dispatchEvent(new KeyboardEvent(type, evData));
        });

        if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
            const splitPacket = new Uint8Array([17]);
            sendMethod.call(activeSocket, splitPacket.buffer);
        }
    }

    function checkAndRespawn() {
        if (!running) return;
        const advert = document.getElementById('advert');
        const playBtn = document.getElementById('playBtn');
        const isDead = (advert && advert.style.display === 'block') || (playBtn && playBtn.offsetHeight > 0);

        if (isDead) {
            if (typeof myWin.closeAdvert === 'function') {
                try { myWin.closeAdvert(); } catch (e) { }
            }
            const nickInput = document.getElementById('nick');
            const nickName = nickInput ? nickInput.value : '';

            if (typeof myWin.setNick === 'function') {
                myWin.setNick(nickName);
            } else if (typeof myWin.rspwn === 'function') {
                myWin.rspwn(nickName);
            } else if (playBtn) {
                playBtn.click();
            }
        }
    }

    // Đọc giá trị giây chuẩn xác (cho phép = 0)
    function getDirectionSeconds(id) {
        const el = document.getElementById(id);
        if (!el) return 0;
        const val = parseFloat(el.value);
        return (isNaN(val) || val <= 0) ? 0 : val;
    }

    function updateSkippedVisuals() {
        const pairs = [
            { box: 'box-r', input: 'time-r' },
            { box: 'box-d', input: 'time-d' },
            { box: 'box-l', input: 'time-l' },
            { box: 'box-u', input: 'time-u' }
        ];
        pairs.forEach(p => {
            const boxEl = document.getElementById(p.box);
            if (!boxEl) return;
            const sec = getDirectionSeconds(p.input);
            if (sec <= 0) {
                boxEl.classList.add('dir-disabled');
            } else {
                boxEl.classList.remove('dir-disabled');
            }
        });
    }

    // --- CẬP NHẬT ĐẾM NGƯỢC & THANH TIẾN TRÌNH ---
    function updateCountdownUI() {
        if (!running) return;
        const timerEl = document.getElementById('bot-countdown');
        const barEl = document.getElementById('bot-progress-bar');

        if (orientation === "none" || stepDuration <= 0) {
            if (timerEl) timerEl.textContent = `0.0s`;
            if (barEl) barEl.style.width = `0%`;
            return;
        }

        const elapsed = Date.now() - stepStartTime;
        const remainingMs = Math.max(0, stepDuration - elapsed);
        const remainingSec = (remainingMs / 1000).toFixed(1);
        const percent = Math.max(0, Math.min(100, (remainingMs / stepDuration) * 100));

        if (timerEl) timerEl.textContent = `${remainingSec}s`;
        if (barEl) barEl.style.width = `${percent}%`;
    }

    function highlightActiveDirection(stepIdx) {
        const ids = ['box-r', 'box-d', 'box-l', 'box-u'];
        ids.forEach((id, idx) => {
            const el = document.getElementById(id
