// ==UserScript==
// @name         Agma.io Auto Coin Farmer (Split-Scan-Collect)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Đứng im max split quét coin -> Tự di chuyển nhặt coin + nhấn M -> Không thấy coin tự nhấn M làm lại
// @author       Custom Script
// @match        *://agma.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ================= CẤU HÌNH THÔNG SỐ (CÓ THỂ TÙY CHỈNH) =================
    const CONFIG = {
        TOGGLE_KEY: 'KeyZ',         // Phím bật/tắt Auto Coin (Mặc định: phím Z)
        ACTION_KEY: 'm',            // Phím nhấn sau khi nhặt hoặc khi không thấy coin
        ACTION_KEYCODE: 77,         // Mã phím M (77)
        SPLIT_COUNT: 7,             // Số lần nhấn Space liên tục để đạt Max Split (2^7 = 128)
        SPLIT_INTERVAL: 65,         // Khoảng nghỉ giữa mỗi lần nhấn Space (ms)
        ZOOM_WAIT_TIME: 1600,       // Thời gian đứng im chờ camera zoom rộng tối đa để quét coin (ms)
        COLLECT_TIMEOUT: 6000,      // Thời gian tối đa đuổi theo 1 cụm coin trước khi ép nhấn M (ms)
        POST_COLLECT_DELAY: 350,    // Thời gian chờ thêm sau khi ăn hết coin trên màn hình rồi mới nhấn M (ms)
        AFTER_M_DELAY: 1500,        // Thời gian chờ sau khi nhấn phím M trước khi bắt đầu vòng lặp mới (ms)
        DRAW_ESP: true              // Vẽ vòng tròn & đường chỉ hướng tới đồng coin phát hiện được
    };

    // ================= BIẾN TRẠNG THÁI =================
    let botEnabled = false;
    let botState = 'IDLE'; // Các trạng thái: IDLE, SPLITTING, SCANNING, COLLECTING, COOLDOWN
    let stateTimer = 0;
    let lastCoinSeenTime = 0;
    let splitStep = 0;
    let lastSplitTime = 0;

    let detectedCoins = [];   // Danh sách coin trong frame hiện tại
    let activeCoins = [];     // Danh sách coin đã chốt ở cuối mỗi frame

    // ================= 1. HOOK CANVAS ĐỂ QUÉT TỌA ĐỘ COIN =================
    const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;

    function isCoinImage(img) {
        if (!img) return false;
        if (img._isCoinSprite) return true;
        if (img instanceof HTMLImageElement && img.src) {
            const src = img.src.toLowerCase();
            // Bắt ảnh coin của map, loại trừ skin/mũ của người chơi có chữ "coin"
            if (src.includes('coin') && !src.includes('/skins/') && !src.includes('/wearables/') && !src.includes('/hats/')) {
                img._isCoinSprite = true;
                return true;
            }
        }
        return false;
    }

    CanvasRenderingContext2D.prototype.drawImage = function(...args) {
        const img = args[0];

        if (isCoinImage(img)) {
            // Nếu game vẽ đệm lên offscreen canvas trước, đánh dấu canvas đó là coin sprite
            if (this.canvas && this.canvas.id !== 'canvas') {
                this.canvas._isCoinSprite = true;
            }
            // Nếu vẽ trực tiếp lên canvas chính của game
            else if (this.canvas && this.canvas.id === 'canvas') {
                let dx, dy, dw, dh;
                if (args.length === 3) {
                    dx = args[1]; dy = args[2];
                    dw = img.width || 0; dh = img.height || 0;
                } else if (args.length === 5) {
                    dx = args[1]; dy = args[2];
                    dw = args[3]; dh = args[4];
                } else if (args.length === 9) {
                    dx = args[5]; dy = args[6];
                    dw = args[7]; dh = args[8];
                }

                // Tính tâm của đồng coin trong hệ tọa độ thế giới
                const localX = dx + dw / 2;
                const localY = dy + dh / 2;

                // Chuyển đổi sang tọa độ pixel trên màn hình qua ma trận Camera hiện tại
                const matrix = this.getTransform();
                const screenX = matrix.a * localX + matrix.c * localY + matrix.e;
                const screenY = matrix.b * localX + matrix.d * localY + matrix.f;

                // Chỉ lấy các coin nằm trong khung nhìn hợp lệ
                if (screenX >= 0 && screenX <= this.canvas.width && screenY >= 0 && screenY <= this.canvas.height) {
                    detectedCoins.push({ x: screenX, y: screenY });
                }
            }
        }

        return origDrawImage.apply(this, args);
    };

    // ================= 2. HÀM GIẢ LẬP CHUỘT & BÀN PHÍM =================
    function moveMouseTo(x, y) {
        const canvas = document.getElementById('canvas');
        if (!canvas) return;
        const evt = new MouseEvent('mousemove', {
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
            view: window
        });
        canvas.dispatchEvent(evt);
    }

    function standStillCenter() {
        moveMouseTo(window.innerWidth / 2, window.innerHeight / 2);
    }

    function pressKey(keyChar, keyCode, codeStr) {
        const targets = [window, document, document.getElementById('canvas')].filter(Boolean);
        ['keydown', 'keyup'].forEach(type => {
            targets.forEach(target => {
                const evt = new KeyboardEvent(type, {
                    key: keyChar,
                    code: codeStr,
                    keyCode: keyCode,
                    which: keyCode,
                    bubbles: true,
                    cancelable: true
                });
                target.dispatchEvent(evt);
            });
        });
    }

    function triggerSplit() {
        pressKey(' ', 32, 'Space');
    }

    function triggerKeyM() {
        pressKey(CONFIG.ACTION_KEY, CONFIG.ACTION_KEYCODE, 'KeyM');
    }

    // Tìm đồng coin gần tâm màn hình nhất
    function getNearestCoin() {
        if (activeCoins.length === 0) return null;
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        let nearest = null;
        let minDist = Infinity;

        for (const c of activeCoins) {
            const dist = Math.hypot(c.x - cx, c.y - cy);
            if (dist < minDist) {
                minDist = dist;
                nearest = c;
            }
        }
        return nearest;
    }

    // ================= 3. VÒNG LẶP LOGIC TRẠNG THÁI (STATE MACHINE) =================
    function updateBotLoop() {
        // Chốt danh sách coin quét được trong frame vừa rồi và làm mới bộ đệm
        activeCoins = detectedCoins.slice();
        detectedCoins = [];

        const now = performance.now();
        const nearestCoin = getNearestCoin();

        if (botEnabled) {
            // Vẽ ESP dẫn đường tới coin nếu bật
            if (CONFIG.DRAW_ESP && nearestCoin) {
                drawESP(nearestCoin);
            }

            switch (botState) {
                case 'IDLE':
                    // Bước 1: Đứng im tại tâm và bắt đầu quá trình Split Max
                    standStillCenter();
                    splitStep = 0;
                    lastSplitTime = now;
                    botState = 'SPLITTING';
                    break;

                case 'SPLITTING':
                    // Luôn giữ chuột ở chính giữa để đứng im khi đang tách mảnh
                    standStillCenter();

                    // Nếu đang split mà phát hiện có coin ngay cạnh thì lao đi nhặt luôn hoặc chờ split xong
                    if (now - lastSplitTime >= CONFIG.SPLIT_INTERVAL) {
                        triggerSplit();
                        splitStep++;
                        lastSplitTime = now;

                        if (splitStep >= CONFIG.SPLIT_COUNT) {
                            botState = 'SCANNING';
                            stateTimer = now;
                        }
                    }
                    break;

                case 'SCANNING':
                    // Đứng im chờ camera mở rộng tầm nhìn tối đa
                    standStillCenter();

                    // Bước 2: Nếu thấy coin -> Chuyển ngay sang chế độ di chuyển tới nhặt
                    if (nearestCoin) {
                        botState = 'COLLECTING';
                        stateTimer = now;
                        lastCoinSeenTime = now;
                        break;
                    }

                    // Bước 3: Nếu đã chờ mở hết tầm nhìn mà vẫn không thấy coin -> Nhấn M rồi lặp lại
                    if (now - stateTimer >= CONFIG.ZOOM_WAIT_TIME) {
                        triggerKeyM();
                        botState = 'COOLDOWN';
                        stateTimer = now;
                    }
                    break;

                case 'COLLECTING':
                    if (nearestCoin) {
                        // Di chuyển chuột trực tiếp về phía đồng coin gần nhất
                        moveMouseTo(nearestCoin.x, nearestCoin.y);
                        lastCoinSeenTime = now;

                        // Tránh trường hợp bị kẹt quá lâu (ví dụ vướng virus/tường không ăn được)
                        if (now - stateTimer >= CONFIG.COLLECT_TIMEOUT) {
                            triggerKeyM();
                            botState = 'COOLDOWN';
                            stateTimer = now;
                        }
                    } else {
                        // Đã nhặt xong coin (không còn thấy coin trên màn hình sau khoảng trễ ngắn)
                        if (now - lastCoinSeenTime >= CONFIG.POST_COLLECT_DELAY) {
                            triggerKeyM();
                            botState = 'COOLDOWN';
                            stateTimer = now;
                        }
                    }
                    break;

                case 'COOLDOWN':
                    // Chờ một nhịp sau khi nhấn phím M rồi quay lại Bước 1 (Đứng im + Split Max)
                    standStillCenter();
                    if (now - stateTimer >= CONFIG.AFTER_M_DELAY) {
                        botState = 'IDLE';
                    }
                    break;
            }
        }

        updateHUD();
        requestAnimationFrame(updateBotLoop);
    }

    // ================= 4. HIỂN THỊ ESP & BẢNG TRẠNG THÁI (HUD) =================
    function drawESP(target) {
        const canvas = document.getElementById('canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.save();
        ctx.resetTransform(); // Vẽ theo tọa độ màn hình chuẩn
        ctx.beginPath();
        ctx.moveTo(window.innerWidth / 2, window.innerHeight / 2);
        ctx.lineTo(target.x, target.y);
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(target.x, target.y, 18, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
    }

    let hudEl = null;
    function createHUD() {
        hudEl = document.createElement('div');
        hudEl.style.cssText = `
            position: fixed;
            top: 12px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(15, 20, 30, 0.85);
            color: #fff;
            padding: 8px 16px;
            border-radius: 8px;
            font-family: Consolas, monospace;
            font-size: 13px;
            z-index: 99999;
            border: 1px solid #445;
            pointer-events: none;
            text-align: center;
            box-shadow: 0 4px 10px rgba(0,0,0,0.4);
        `;
        document.body.appendChild(hudEl);
    }

    function updateHUD() {
        if (!hudEl) return;
        const statusColor = botEnabled ? '#00ff88' : '#ff5555';
        const statusText = botEnabled ? 'BẬT (ON)' : 'TẮT (OFF)';
        hudEl.innerHTML = `
            <div><b>AUTO COIN [Phím Z]:</b> <span style="color:${statusColor}">${statusText}</span></div>
            <div style="margin-top:3px; color:#ccc;">Trạng thái: <b style="color:#ffd700">${botState}</b> | Coin trong tầm nhìn: <b>${activeCoins.length}</b></div>
        `;
    }

    // ================= 5. KHỞI TẠO & LẮNG NGHE PHÍM BẬT/TẮT =================
    window.addEventListener('keydown', (e) => {
        // Không kích hoạt phím tắt khi đang gõ chat hoặc nhập tên
        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

        if (e.code === CONFIG.TOGGLE_KEY) {
            botEnabled = !botEnabled;
            botState = 'IDLE';
            if (botEnabled) {
                standStillCenter();
            }
        }
    });

    window.addEventListener('DOMContentLoaded', () => {
        createHUD();
        requestAnimationFrame(updateBotLoop);
    });
})();

