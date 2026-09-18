let selectedLangs = [];
let detectedVideoId = null;
let currentDisplayLang = 'vn'; // 'vn' hoặc 'en'
let audioFile = null; // File âm thanh dùng chung cho mọi ngôn ngữ (chỉ giữ trong phiên)
let isRunningAll = false;
let isAdding = false; // Đang thêm 1 ngôn ngữ (lẻ hoặc trong Chạy tất cả)
let isSyncing = false;
let lastSyncedVideoId = null; // Video đã tự Reload gần nhất
let runTabId = null; // Tab YouTube Studio đang chạy "Chạy tất cả"
let runWindowId = null;
let runVideoId = null;
let stopReason = null; // Lý do dừng "Chạy tất cả" (chuyển tab / rời trang)
let videoExtraLangs = []; // Ngôn ngữ có trên video nhưng chưa có trong danh sách

document.addEventListener('DOMContentLoaded', () => {
    loadSelectedLangs();
    renderLanguageSelect();
    checkCurrentTab();
    setupEventListeners();
    setInterval(pollProcessing, 30000);

    // Lắng nghe khi tab được cập nhật (URL thay đổi)
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        // Đang chạy mà tab Studio rời khỏi trang Translations của video đó → dừng
        if (isRunningAll && tabId === runTabId && changeInfo.url
            && !changeInfo.url.includes(`/video/${runVideoId}/translations`)) {
            stopRun('Trang YouTube Studio đã chuyển đi');
        }
        if (changeInfo.url || changeInfo.status === 'complete') {
            checkCurrentTab();
        }
    });

    // Lắng nghe khi chuyển sang tab khác
    chrome.tabs.onActivated.addListener((activeInfo) => {
        if (isRunningAll && activeInfo.windowId === runWindowId && activeInfo.tabId !== runTabId) {
            stopRun('Bạn đã chuyển sang tab khác');
        }
        checkCurrentTab();
    });
});

function isBusy() {
    return isRunningAll || isAdding;
}

// Khoá Reload khi đang thêm ngôn ngữ. Nút Chạy tất cả thành nút Dừng khi đang chạy tất cả,
// và bị khoá khi đang thêm 1 ngôn ngữ lẻ.
function updateBusyUI() {
    const btnRun = document.getElementById('btnRunAll');
    document.getElementById('btnSync').disabled = isBusy();
    btnRun.disabled = isAdding && !isRunningAll;
    btnRun.classList.toggle('btn-stop', isRunningAll);
    if (!isRunningAll) btnRun.textContent = '▶ Chạy tất cả';
}

function getDisplayName(lang) {
    return currentDisplayLang === 'vn' ? (lang.nameVn || lang.name) : lang.name;
}

function renderLanguageSelect(filterText = '') {
    const select = document.getElementById('langSelect');
    
    // Lọc theo từ khóa tìm kiếm
    let filtered = LANGUAGES;
    if (filterText) {
        const query = filterText.toLowerCase();
        filtered = LANGUAGES.filter(lang => {
            const code = lang.code.toLowerCase();
            const nameEn = lang.name.toLowerCase();
            const nameVn = (lang.nameVn || '').toLowerCase();
            return code.includes(query) || nameEn.includes(query) || nameVn.includes(query);
        });
    }
    
    // Sắp xếp theo tên hiện tại
    const sorted = [...filtered].sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b)));
    
    if (sorted.length === 0) {
        select.innerHTML = '<option disabled>Không tìm thấy ngôn ngữ nào</option>';
    } else {
        select.innerHTML = sorted.map(lang => {
            const displayName = getDisplayName(lang);
            return `<option value="${lang.code}">${lang.code} - ${displayName}</option>`;
        }).join('');
    }
    markAddedOptions();
}

// Ngôn ngữ đã có trong danh sách thì tô xám trong ô chọn
function markAddedOptions() {
    document.querySelectorAll('#langSelect option').forEach(opt => {
        opt.classList.toggle('lang-added', selectedLangs.some(l => l.code === opt.value));
    });
}

function getLangName(code, fallbackName) {
    const lang = LANGUAGES.find(l => l.code === code);
    return lang ? getDisplayName(lang) : (fallbackName || code);
}

// Nhãn trạng thái lấy từ YouTube Studio (Đã xuất bản / Đang xử lý... % / Đã xoá / chưa có âm thanh)
function getYtBadge(ytStatus, ytText) {
    if (ytStatus === 'none') return { text: 'Chưa có âm thanh', cls: 'status-pending' };
    return {
        text: ytText,
        cls: { published: 'status-done', processing: 'status-processing', error: 'status-error' }[ytStatus] || 'status-pending'
    };
}

function renderLangList() {
    const container = document.getElementById('langList');

    // Sắp xếp danh sách cùng thứ tự với ô chọn ngôn ngữ
    selectedLangs.sort((a, b) => getLangName(a.code, a.name).localeCompare(getLangName(b.code, b.name)));
    markAddedOptions();

    const itemsHtml = selectedLangs.length === 0
        ? '<div class="empty-state"><div class="empty-state-icon">📋</div><div>Chưa có ngôn ngữ nào</div></div>'
        : selectedLangs.map((item, index) => {
        const displayName = getLangName(item.code, item.name);

        let statusClass = 'status-pending';
        let statusText = 'Chờ';
        if (item.status === 'processing') {
            statusClass = 'status-processing';
            statusText = 'Đang xử lý';
        } else if (item.status === 'done') {
            statusClass = 'status-done';
            statusText = 'Hoàn thành';
        }

        // Trạng thái lấy từ YouTube Studio khi Reload
        if (item.ytStatus) {
            const badge = getYtBadge(item.ytStatus, item.ytText);
            statusText = badge.text;
            statusClass = badge.cls;
        }

        // Ngôn ngữ đã có trong bảng Bản dịch (đã xoá / lỗi / chưa có âm thanh) thì menu "Thêm ngôn ngữ"
        // khoá mục đó, nên không thêm lại được - tự xử lý trên Studio
        const disabled = item.status === 'processing' || item.status === 'done' || !!item.ytStatus;

        return `
            <div class="lang-item">
                <div class="lang-info">
                    <span class="lang-code">${item.code}</span>
                    <span class="lang-name">${displayName}</span>
                </div>
                <span class="lang-status ${statusClass}">${statusText}</span>
                <div class="lang-actions">
                    <button class="btn btn-add" data-index="${index}" ${disabled ? 'disabled' : ''}>Thêm</button>
                    <button class="btn btn-remove" data-index="${index}" title="Xóa khỏi danh sách">✕</button>
                </div>
            </div>
        `;
    }).join('');

    // Ngôn ngữ có trên video nhưng chưa có trong danh sách - chỉ thêm khi người dùng bấm
    let extrasHtml = '';
    if (videoExtraLangs.length > 0) {
        extrasHtml = `
            <div class="extra-box">
                <div class="extra-note">
                    Video này có <strong>${videoExtraLangs.length}</strong> ngôn ngữ bạn chưa thêm vào Extension.
                    Bấm <strong>+ Thêm vào DS</strong> nếu muốn quản lý, không thì cứ bỏ qua.
                </div>
                ${videoExtraLangs.map((row, i) => {
                    const badge = getYtBadge(row.status, row.text);
                    return `
                        <div class="lang-item">
                            <div class="lang-info">
                                <span class="lang-code">${row.code}</span>
                                <span class="lang-name">${getLangName(row.code, row.name)}</span>
                            </div>
                            <span class="lang-status ${badge.cls}">${badge.text}</span>
                            <div class="lang-actions">
                                <button class="btn btn-add btn-add-extra" data-index="${i}">+ Thêm vào DS</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    container.innerHTML = itemsHtml + extrasHtml;

    // Gắn event listener cho các nút "Thêm"
    container.querySelectorAll('.btn-add:not(.btn-add-extra)').forEach(btn => {
        btn.addEventListener('click', () => {
            if (isBusy()) return;
            const index = parseInt(btn.dataset.index);
            addDubForLang(index);
        });
    });

    // Gắn event listener cho các nút "+ Thêm vào DS"
    container.querySelectorAll('.btn-add-extra').forEach(btn => {
        btn.addEventListener('click', () => {
            addExtraToList(videoExtraLangs[parseInt(btn.dataset.index)]);
        });
    });
    
    // Gắn event listener cho các nút "Xóa"
    container.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.dataset.index);
            removeLangFromList(index);
        });
    });
}

function removeLangFromList(index) {
    selectedLangs.splice(index, 1);
    saveSelectedLangs();
    renderLangList();
}

// Chuyển 1 ngôn ngữ có sẵn trên video vào danh sách (giữ trạng thái YouTube của nó)
function addExtraToList(row) {
    if (!row) return;
    selectedLangs.push({
        code: row.code,
        name: row.name,
        status: row.status === 'published' ? 'done' : row.status === 'processing' ? 'processing' : 'pending',
        ytStatus: row.status,
        ytText: row.text
    });
    videoExtraLangs = videoExtraLangs.filter(r => r.code !== row.code);
    saveSelectedLangs();
    renderLangList();
}

function setupEventListeners() {
    // Search
    document.getElementById('langSearch').addEventListener('input', (e) => {
        const query = e.target.value;
        renderLanguageSelect(query);
    });
    
    // Language toggle
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentDisplayLang = btn.dataset.lang;
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const searchQuery = document.getElementById('langSearch').value;
            renderLanguageSelect(searchQuery);
            renderLangList();
        });
    });
    
    // Add language
    document.getElementById('btnAddLang').addEventListener('click', () => {
        const select = document.getElementById('langSelect');
        const code = select.value;
        
        if (!code) return;
        
        // Kiểm tra đã có chưa
        if (selectedLangs.find(l => l.code === code)) {
            alert('Ngôn ngữ này đã có trong danh sách!');
            return;
        }

        // Ngôn ngữ đã có trên video → thêm kèm trạng thái YouTube (khoá nút Thêm)
        const extra = videoExtraLangs.find(r => r.code === code);
        if (extra) {
            addExtraToList(extra);
            return;
        }

        selectedLangs.push({
            code: code,
            status: 'pending'
        });
        
        saveSelectedLangs();
        renderLangList();
    });
    
    // Import
    document.getElementById('btnImport').addEventListener('click', () => {
        document.getElementById('importFile').click();
    });
    
    document.getElementById('importFile').addEventListener('change', importPreset);
    
    // Export
    document.getElementById('btnExport').addEventListener('click', exportPreset);
    
    // Clear
    document.getElementById('btnClear').addEventListener('click', () => {
        if (confirm('Xóa tất cả ngôn ngữ trong danh sách?')) {
            selectedLangs = [];
            saveSelectedLangs();
            renderLangList();
        }
    });
    
    // Sync
    document.getElementById('btnSync').addEventListener('click', () => syncStatus());

    // Chạy tất cả / Dừng
    document.getElementById('btnRunAll').addEventListener('click', () => {
        if (isRunningAll) {
            stopRun('Bạn đã bấm Dừng');
            document.getElementById('btnRunAll').textContent = '⏳ Đang dừng...';
        } else {
            runAll();
        }
    });

    // Chọn file âm thanh
    document.getElementById('btnPickAudio').addEventListener('click', () => {
        document.getElementById('audioFile').click();
    });

    document.getElementById('audioFile').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        audioFile = file;
        document.getElementById('audioFileName').textContent = file.name;
    });
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        const url = (tab && tab.url) || ''; // Không lấy được tab → hiện cảnh báo như sai tab
        const match = url.match(/studio\.youtube\.com\/video\/([a-zA-Z0-9_-]+)/);
        
        const statusBox = document.getElementById('statusBox');
        const overlay = document.getElementById('overlay');
        
        if (match && match[1]) {
            detectedVideoId = match[1];
            if (url.includes('/translations')) {
                statusBox.className = 'status-box status-ok';
                statusBox.innerHTML = `<span>✅</span><span>Sẵn sàng! Video: <strong>${detectedVideoId}</strong></span>`;
                overlay.classList.add('hidden');
                autoSync(detectedVideoId);
            } else {
                statusBox.className = 'status-box status-warn';
                statusBox.innerHTML = `<span>⚠️</span><span>Vui lòng vào trang Translations</span>`;
                overlay.classList.remove('hidden');
            }
        } else {
            detectedVideoId = null;
            statusBox.className = 'status-box status-warn';
            statusBox.innerHTML = `<span>⚠️</span><span>Chưa mở YouTube Studio</span>`;
            overlay.classList.remove('hidden');
        }
    });
}

// tabId: tab cố định khi Chạy tất cả; bỏ trống = tab đang mở
// Trả về null nếu thành công, hoặc nội dung lỗi. Khi Chạy tất cả thì không alert (runAll báo gộp ở cuối).
async function addDubForLang(index, tabId = null) {
    const item = selectedLangs[index];
    const lang = LANGUAGES.find(l => l.code === item.code);

    if (!lang) {
        const msg = `Extension chưa hỗ trợ tự thêm ngôn ngữ ${item.code}. Hãy thêm thủ công trên YouTube Studio.`;
        if (!isRunningAll) alert(msg);
        return msg;
    }

    console.log('Starting addDubForLang for:', item.code, lang.name);

    // Cập nhật trạng thái (bỏ trạng thái YouTube cũ, lần Reload sau sẽ lấy lại)
    item.status = 'processing';
    item.ytStatus = null;
    item.ytText = '';
    isAdding = true;
    updateBusyUI();
    saveSelectedLangs();
    renderLangList();

    let error = null;
    try {
        if (!tabId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) throw new Error('Không lấy được tab YouTube Studio');
            tabId = tab.id;
        }

        // Inject content script và thực hiện
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            console.log('Content script injected successfully');
        } catch (e) {
            console.log('Script injection:', e.message);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        // Gửi file âm thanh (nếu đã chọn) theo từng phần - Chrome giới hạn 64MiB mỗi tin nhắn
        let audio = null;
        if (audioFile) {
            const data = await readFileAsBase64(audioFile);
            await sendToTab(tabId, { action: 'audio_reset' });
            for (let i = 0; i < data.length; i += AUDIO_CHUNK_SIZE) {
                await sendToTab(tabId, { action: 'audio_chunk', data: data.slice(i, i + AUDIO_CHUNK_SIZE) });
            }
            audio = { name: audioFile.name, type: audioFile.type };
        }

        if (stopReason) throw new Error(stopReason);

        console.log('Sending message to content script...');
        const response = await sendToTab(tabId, {
            action: "add_single_lang",
            langCode: item.code,
            langName: lang.name,
            langNameVn: lang.nameVn || lang.name,
            audio: audio
        });
        console.log('Response from content script:', response);

        if (!response || !response.success) {
            throw new Error(response ? response.error : 'Không nhận được phản hồi từ trang');
        }

        if (response.alreadyOnVideo) {
            // Ngôn ngữ đã có trên video (vd: vừa Lưu từ hộp thoại dở dang) → lấy trạng thái thật từ bảng
            const row = await readRowOfLang(tabId, item.code, 0);
            if (!row) throw new Error(`Ngôn ngữ ${item.code} bị khoá trong menu nhưng không thấy trong bảng Bản dịch`);
            applyRowToItem(item, row);
        } else if (audio) {
            // Vừa tải âm thanh → lấy trạng thái thật từ bảng (thường là Đang xử lý... %), không tự coi là xong
            const row = await readRowOfLang(tabId, item.code, 10000);
            if (row) {
                applyRowToItem(item, row);
            } else {
                item.status = 'processing';
                item.ytStatus = 'processing';
                item.ytText = 'Đang xử lý';
            }
        } else {
            item.status = 'done';
        }
    } catch (e) {
        console.error('Error:', e);
        item.status = 'pending';
        error = e.message;
        // Đang Chạy tất cả (bỏ qua lỗi / dừng do chuyển tab) thì runAll báo ở cuối, không alert ở đây
        if (!isRunningAll) alert('Lỗi: ' + e.message);
    }

    isAdding = false;
    updateBusyUI();
    saveSelectedLangs();
    renderLangList();
    return error;
}

// Dừng "Chạy tất cả": ngắt thao tác đang dở trên trang và không sang ngôn ngữ tiếp theo
function stopRun(reason) {
    if (!isRunningAll || stopReason) return;
    stopReason = reason;
    chrome.tabs.sendMessage(runTabId, { action: 'abort', reason: reason }, () => {
        void chrome.runtime.lastError; // Tab có thể đã rời trang - bỏ qua
    });
}

// Chạy lần lượt mọi ngôn ngữ chưa hoàn thành. Ngôn ngữ bị lỗi thì bỏ qua, chạy tiếp; dừng khi chuyển tab / bấm Dừng
async function runAll() {
    if (isBusy()) return;

    if (!audioFile) {
        alert('Chọn file âm thanh trước khi chạy tất cả!');
        return;
    }

    const queue = selectedLangs.filter(l => l.status !== 'done' && l.status !== 'processing' && !l.ytStatus);
    if (queue.length === 0) {
        alert('Không còn ngôn ngữ nào cần chạy!');
        return;
    }

    // Giữ cố định tab YouTube Studio lúc bắt đầu chạy
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const match = ((tab && tab.url) || '').match(/studio\.youtube\.com\/video\/([a-zA-Z0-9_-]+)\/translations/);
    if (!match) {
        alert('Hãy mở trang Translations của video trên YouTube Studio trước!');
        return;
    }

    const btn = document.getElementById('btnRunAll');
    const notice = document.getElementById('runNotice');
    isRunningAll = true;
    runTabId = tab.id;
    runWindowId = tab.windowId;
    runVideoId = match[1];
    stopReason = null;
    notice.hidden = false;
    updateBusyUI();

    const failed = []; // Ngôn ngữ bị lỗi đã bỏ qua
    for (let i = 0; i < queue.length; i++) {
        if (stopReason) break;
        const index = selectedLangs.indexOf(queue[i]);
        if (index === -1) continue; // Đã bị xoá khỏi danh sách giữa chừng

        btn.textContent = `⏹ Dừng (đang chạy ${i + 1}/${queue.length})`;
        const error = await addDubForLang(index, runTabId);
        if (stopReason) break;
        if (error) failed.push(`• ${queue[i].code}: ${error}`);

        // Chờ hộp thoại đóng hẳn trước khi sang ngôn ngữ tiếp theo
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const reason = stopReason;
    isRunningAll = false;
    runTabId = null;
    runWindowId = null;
    runVideoId = null;
    stopReason = null;
    notice.hidden = true;
    updateBusyUI();

    const failedText = failed.length
        ? `\n\n⚠️ ${failed.length} ngôn ngữ bị lỗi đã bỏ qua (vẫn ở trạng thái Chờ):\n${failed.join('\n')}`
        : '';
    if (reason) {
        alert(`⛔ Đã dừng Chạy tất cả: ${reason}.\nCác ngôn ngữ chưa chạy vẫn ở trạng thái Chờ, bấm Chạy tất cả để chạy tiếp.${failedText}`);
    } else if (failed.length) {
        alert(`Chạy tất cả đã xong.${failedText}\n\nBấm Chạy tất cả để thử lại các ngôn ngữ này.`);
    }
}

// Base64 chia phần, bội số của 4 để mỗi phần tự giải mã được
const AUDIO_CHUNK_SIZE = 8 * 1024 * 1024;

function sendToTab(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

function loadSelectedLangs() {
    chrome.storage.local.get(['selectedLangs'], (result) => {
        selectedLangs = result.selectedLangs || [];
        renderLangList();
    });
}

function saveSelectedLangs() {
    chrome.storage.local.set({ selectedLangs });
}

// Đọc bảng Bản dịch trên trang YouTube Studio.
// Chạy trong MAIN world để lấy được mã ngôn ngữ (row.videoTranslation) - content script không thấy thuộc tính này.
// waitForLoad: chờ bảng hiện đúng video (dùng khi vừa chuyển video, bảng có thể chưa tải xong).
async function readTranslationRows(videoId, waitForLoad) {
    if (waitForLoad) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const start = Date.now();
        let lastCount = -1;
        let emptySince = null;
        let loaded = false;
        while (!loaded && Date.now() - start < 15000) {
            const rows = [...document.querySelectorAll('ytgn-video-translation-row')];
            if (rows.length === 0) {
                // Bảng trống liên tục 3 giây → coi như video chưa có ngôn ngữ nào
                emptySince = emptySince || Date.now();
                loaded = Date.now() - emptySince >= 3000;
            } else {
                emptySince = null;
                // Các dòng có âm thanh phải thuộc đúng video, và số dòng không đổi giữa 2 lần kiểm tra
                const sameVideo = rows.every(r => {
                    const at = r.videoTranslation && r.videoTranslation.audioTranslation;
                    return !at || !at.videoId || at.videoId === videoId;
                });
                loaded = sameVideo && rows.length === lastCount;
                lastCount = rows.length;
            }
            if (!loaded) await sleep(300);
        }
        if (!loaded) return null; // Bảng vẫn là của video cũ → không đọc
    }

    return [...document.querySelectorAll('ytgn-video-translation-row')].map(row => {
        const vt = row.videoTranslation || {};
        const cell = row.querySelector('ytgn-video-translation-cell-audio #status-container');
        const text = cell ? cell.textContent.trim().normalize('NFC') : '';
        let status = 'none';
        if (cell && cell.querySelector('.status-error')) status = 'error'; // Đã xoá / lỗi
        else if (/%|xử lý|processing/i.test(text)) status = 'processing';
        else if (/xuất bản|published/i.test(text)) status = 'published';
        const nameEl = row.querySelector('.language-display-name span');
        return {
            code: vt.languageCode || null,
            name: vt.displayName || (nameEl ? nameEl.textContent.trim() : ''),
            status: status,
            text: status === 'none' ? '' : text
        };
    });
}

// Đọc dòng của 1 ngôn ngữ trên bảng Bản dịch, chờ tối đa timeout ms tới khi dòng có trạng thái âm thanh
async function readRowOfLang(tabId, code, timeout) {
    const start = Date.now();
    while (true) {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: readTranslationRows,
            args: [null, false]
        });
        const row = (injection.result || []).find(r => r.code === code);
        if ((row && row.status !== 'none') || Date.now() - start >= timeout) return row || null;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// Gán trạng thái 1 dòng của bảng Bản dịch cho 1 ngôn ngữ trong danh sách. Trả về true nếu có thay đổi.
// Đã xuất bản → Hoàn thành, đang xử lý → Đang xử lý, còn lại (chưa có / đã xoá / lỗi) → Chờ
function applyRowToItem(item, row) {
    let newStatus = 'pending';
    if (row && row.status === 'published') newStatus = 'done';
    else if (row && row.status === 'processing') newStatus = 'processing';
    const newYtText = row ? row.text : '';

    const changed = item.status !== newStatus || (item.ytText || '') !== newYtText;
    item.status = newStatus;
    item.ytStatus = row ? row.status : null;
    item.ytText = newYtText;
    return changed;
}

// Tự Reload khi mở trang Translations của một video khác với lần đồng bộ trước
function autoSync(videoId) {
    if (videoId === lastSyncedVideoId || isSyncing || isBusy()) return;
    lastSyncedVideoId = videoId;
    syncStatus(true).then(ok => {
        if (!ok) lastSyncedVideoId = null; // Lỗi → lần cập nhật tab sau thử lại
    });
}

// Tự cập nhật các ngôn ngữ YouTube đang xử lý (chạy mỗi 30 giây, kể cả khi đang Chạy tất cả).
// Chỉ đọc bảng Bản dịch, không bấm gì trên trang; không còn ngôn ngữ đang xử lý thì bỏ qua.
async function pollProcessing() {
    const items = selectedLangs.filter(l => l.ytStatus === 'processing');
    const videoId = runVideoId || lastSyncedVideoId; // Video mà danh sách đang phản ánh
    if (items.length === 0 || !videoId || isSyncing) return;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !(tab.url || '').includes(`/video/${videoId}/translations`)) return;

        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: readTranslationRows,
            args: [null, false]
        });
        const rows = injection.result || [];
        if (rows.length === 0) return; // Bảng chưa hiện → để lần sau

        let changed = false;
        items.forEach(item => {
            const lang = LANGUAGES.find(l => l.code === item.code);
            const row = rows.find(r => r.code === item.code)
                || (lang && rows.find(r => !r.code && (r.name === lang.name || r.name === lang.nameVn)));
            if (row && applyRowToItem(item, row)) changed = true; // Không thấy dòng → giữ nguyên, Reload xử lý
        });

        if (changed) {
            saveSelectedLangs();
            renderLangList();
        }
    } catch (e) {
        console.log('Poll processing:', e.message); // Tab đóng / rời trang - lần sau thử lại
    }
}

// Sync status từ trang YouTube Studio (auto = true: tự chạy khi chuyển video, không hiện alert)
async function syncStatus(auto = false) {
    if (isBusy()) return false; // Nút Reload đã bị khoá khi đang chạy
    if (isSyncing) return false;
    isSyncing = true;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const match = (tab.url || '').match(/studio\.youtube\.com\/video\/([a-zA-Z0-9_-]+)/);
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: readTranslationRows,
            args: [match ? match[1] : null, auto]
        });
        if (injection.result === null) {
            throw new Error('Bảng Bản dịch chưa tải xong');
        }
        const rows = injection.result || [];
        let updated = 0;

        // Đã xuất bản → Hoàn thành, đang xử lý → Đang xử lý, còn lại (chưa có / đã xoá / lỗi) → Chờ
        selectedLangs.forEach(item => {
            const lang = LANGUAGES.find(l => l.code === item.code);
            const row = rows.find(r => r.code === item.code)
                || (lang && rows.find(r => !r.code && (r.name === lang.name || r.name === lang.nameVn)));

            if (applyRowToItem(item, row)) updated++;
        });

        // Ngôn ngữ có trên video nhưng chưa có trong danh sách → hiện riêng, người dùng tự chọn thêm
        videoExtraLangs = rows.filter(row => row.code && !selectedLangs.some(l => l.code === row.code));

        saveSelectedLangs();
        renderLangList();
        showSyncNotification(updated, videoExtraLangs.length);
        return true;
    } catch (e) {
        console.error('Sync error:', e);
        if (!auto) alert('Lỗi: ' + e.message);
        return false;
    } finally {
        isSyncing = false;
    }
}

function showSyncNotification(count, extra = 0) {
    const statusBox = document.getElementById('statusBox');
    const originalContent = statusBox.innerHTML;
    const originalClass = statusBox.className;

    statusBox.className = 'status-box status-ok';
    const extraText = extra ? `. Video có ${extra} ngôn ngữ chưa có trong danh sách` : '';
    statusBox.innerHTML = `<span>🔄</span><span>Đã đồng bộ! Cập nhật ${count} ngôn ngữ${extraText}</span>`;
    
    setTimeout(() => {
        statusBox.className = originalClass;
        statusBox.innerHTML = originalContent;
    }, 2000);
}


// Export/Import functions
function exportPreset() {
    if (selectedLangs.length === 0) {
        alert('Chưa có ngôn ngữ nào để xuất!');
        return;
    }
    
    // Chỉ xuất mã ngôn ngữ, không kèm trạng thái (trạng thái thuộc về từng video)
    const data = {
        version: '2.0',
        type: 'manual-dub-helper',
        exportDate: new Date().toISOString(),
        languages: selectedLangs.map(l => l.code)
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `manual-dub-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Thu hồi URL sau khi trình duyệt đã bắt đầu tải
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importPreset(event) {
    const file = event.target.files[0];
    event.target.value = ''; // Cho phép chọn lại cùng file lần sau
    if (!file) return;

    try {
        const data = JSON.parse(await file.text());

        if (!data || !Array.isArray(data.languages)) {
            alert('❌ File không đúng định dạng!');
            return;
        }

        // Nhận cả file mới (["ar", ...]) và file cũ ([{code: "ar", status: ...}, ...]) - chỉ lấy mã
        const codes = [];
        let skipped = 0;
        data.languages.forEach(entry => {
            const code = typeof entry === 'string' ? entry : (entry && entry.code);
            if (typeof code !== 'string' || !LANGUAGES.some(l => l.code === code)) {
                skipped++;
                return;
            }
            if (!codes.includes(code)) codes.push(code);
        });

        if (codes.length === 0) {
            alert('❌ File không có mã ngôn ngữ hợp lệ nào!');
            return;
        }

        const merge = confirm(
            `Tìm thấy ${codes.length} ngôn ngữ.\n\n` +
            `Bấm OK để GỘP với danh sách hiện tại.\n` +
            `Bấm Cancel để THAY THẾ toàn bộ.`
        );

        const skippedText = skipped ? `\n(Bỏ qua ${skipped} mục không hợp lệ)` : '';
        if (merge) {
            // Merge: thêm ngôn ngữ mới, bỏ qua trùng
            const newCodes = codes.filter(code => !selectedLangs.some(l => l.code === code));
            selectedLangs.push(...newCodes.map(code => ({ code: code, status: 'pending' })));
            alert(`✅ Đã nhập ${newCodes.length} ngôn ngữ mới!${skippedText}`);
        } else {
            // Replace
            selectedLangs = codes.map(code => ({ code: code, status: 'pending' }));
            alert(`✅ Đã thay thế bằng ${selectedLangs.length} ngôn ngữ!${skippedText}`);
        }

        saveSelectedLangs();
        renderLangList();

        // Lấy lại trạng thái của video đang mở cho danh sách mới
        lastSyncedVideoId = null;
        checkCurrentTab();
    } catch (e) {
        console.error('Import error:', e);
        alert('❌ Lỗi khi đọc file: ' + e.message);
    }
}
