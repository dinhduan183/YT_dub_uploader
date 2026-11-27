let selectedLangs = [];
let detectedVideoId = null;
let currentDisplayLang = 'vn'; // 'vn' hoặc 'en'
let audioFile = null; // File âm thanh dùng chung cho mọi ngôn ngữ (chỉ giữ trong phiên)
let descAudioFile = null; // File âm thanh mô tả dùng chung cho mọi ngôn ngữ (chỉ giữ trong phiên)
let isRunningAll = false;
let runFix = false; // true = đang chạy Auto Fix (xoá âm thanh lỗi rồi thêm), false = Chạy tất cả (bỏ qua ngôn ngữ lỗi)
let isAdding = false; // Đang thêm 1 ngôn ngữ (lẻ hoặc trong Chạy tất cả)
let addingItem = null; // Ngôn ngữ đang thêm - hiện dòng tiến trình dưới tên
let progressText = ''; // Bước đang làm của ngôn ngữ đang thêm
let isSyncing = false;
let isDeleting = false; // Đang xoá âm thanh lỗi
let deleteStopRequested = false; // Đã bấm Dừng khi đang xoá âm thanh lỗi
let deleteTabId = null; // Tab YouTube Studio đang xoá âm thanh lỗi
let deleteVideoId = null;
let deleteAbortReason = null; // Lý do tự dừng xoá (tab rời khỏi video đang xoá)
let lastSyncedVideoId = null; // Video đã tự Reload gần nhất
let runTabId = null; // Tab YouTube Studio đang chạy "Chạy tất cả"
let runWindowId = null;
let runVideoId = null;
let stopReason = null; // Lý do dừng "Chạy tất cả" (chuyển tab / rời trang)
let videoExtraLangs = []; // Ngôn ngữ có trên video nhưng chưa có trong danh sách

document.addEventListener('DOMContentLoaded', () => {
    showWhatsNew();
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
        // Đang xoá âm thanh lỗi mà tab đó chuyển sang trang / video khác → dừng, không xoá nhầm sang video mới
        if (isDeleting && tabId === deleteTabId && changeInfo.url
            && !changeInfo.url.includes(`/video/${deleteVideoId}/translations`)) {
            abortDeleting('Trang YouTube Studio đã chuyển sang video / trang khác');
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
    return isRunningAll || isAdding || isDeleting;
}

// Khoá Reload khi đang thêm ngôn ngữ. Nút Chạy tất cả thành nút Dừng khi đang chạy tất cả,
// và bị khoá khi đang thêm 1 ngôn ngữ lẻ / đang xoá âm thanh lỗi.
function updateBusyUI() {
    document.getElementById('btnSync').disabled = isBusy();
    // Nút xoá đang chạy thành nút Dừng, nút xoá còn lại bị khoá
    ['btnDeleteErrorsAuto', 'btnDeleteErrors', 'btnDeleteErrorsQuick'].forEach(id => {
        const btn = document.getElementById(id);
        const running = isDeleting && btn.dataset.running === '1';
        btn.disabled = running ? deleteStopRequested : isBusy();
        btn.classList.toggle('btn-stop', running);
    });
    // Nút đang chạy thành nút Dừng, nút còn lại bị khoá
    [['btnRunAll', false, '▶ Chạy tất cả'], ['btnAutoFix', true, '🛠 Auto Fix']].forEach(([id, fix, label]) => {
        const btn = document.getElementById(id);
        const running = isRunningAll && runFix === fix;
        btn.disabled = running ? false : isBusy();
        btn.classList.toggle('btn-stop', running);
        if (!running) btn.textContent = label;
    });
}

function runButton() {
    return document.getElementById(runFix ? 'btnAutoFix' : 'btnRunAll');
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

// Video mà danh sách đang phản ánh
function currentVideoId() {
    return runVideoId || detectedVideoId;
}

// Ngôn ngữ còn thiếu gì để bổ sung không (âm thanh gốc, hoặc âm thanh mô tả khi đã chọn file mô tả)
function needsWork(item) {
    if (!item.ytStatus) return item.status !== 'done' && item.status !== 'processing';
    if (item.ytStatus === 'none') return true;
    return !!descAudioFile && item.descVideoId !== currentVideoId();
}

// Ngôn ngữ đã có âm thanh gốc trên video (kể cả bị Removed / lỗi - vẫn thêm được âm thanh mô tả)
function hasMainAudio(item) {
    return item.ytStatus === 'published' || item.ytStatus === 'processing' || item.ytStatus === 'error';
}

const DESC_NEEDS_MAIN_MSG = 'Âm thanh mô tả chỉ thêm được sau khi ngôn ngữ đã có âm thanh gốc.';

// Trạng thái âm thanh mô tả đọc được khi mở hộp ngôn ngữ (không hiện trên bảng Bản dịch): 'ok' / 'error' / 'none'
// Ghi theo video; descVideoId (đã có mô tả tốt) giữ khớp để needsWork dùng như cũ
function setDescState(item, videoId, state) {
    item.descState = state;
    item.descStateVideoId = videoId;
    if (state === 'ok') item.descVideoId = videoId;
    else if (item.descVideoId === videoId) item.descVideoId = null;
}

// null = chưa mở hộp ngôn ngữ này nên chưa biết
function getDescState(item) {
    const videoId = currentVideoId();
    if (item.descStateVideoId === videoId && item.descState) return item.descState;
    return item.descVideoId && item.descVideoId === videoId ? 'ok' : null;
}

const DESC_BADGES = {
    ok: { text: 'Đã có', cls: 'status-done' },
    error: { text: 'Lỗi', cls: 'status-error' },
    none: { text: 'Chưa có', cls: 'status-pending' }
};

function renderLangList() {
    const container = document.getElementById('langList');

    // Sắp xếp danh sách cùng thứ tự với ô chọn ngôn ngữ
    selectedLangs.sort((a, b) => getLangName(a.code, a.name).localeCompare(getLangName(b.code, b.name)));
    markAddedOptions();

    const itemsHtml = selectedLangs.length === 0
        ? '<div class="empty-state"><div class="empty-state-icon">📋</div><div>Chưa có ngôn ngữ nào</div></div>'
        : selectedLangs.map((item, index) => {
        const displayName = getLangName(item.code, item.name);

        // Cột Gốc: Đã có (Published / Processing) / Lỗi / Chưa có ("–" trên bảng) / Unknown (chưa đọc bảng).
        // Processing giữ màu vàng để còn phân biệt; chữ gốc của YouTube xem khi rê chuột.
        let statusClass = 'status-unknown';
        let statusText = 'Unknown';
        let statusTitle = 'Chưa đọc được trạng thái từ YouTube Studio';
        if (item.ytStatus) {
            const badge = getYtBadge(item.ytStatus, item.ytText);
            statusClass = badge.cls;
            statusText = { published: 'Đã có', processing: 'Đã có', error: 'Lỗi', none: 'Chưa có' }[item.ytStatus] || badge.text;
            statusTitle = badge.text;
        } else if (item.status === 'processing') {
            statusClass = 'status-processing';
            statusText = statusTitle = 'Đang xử lý'; // Đang thêm bằng extension
        } else if (item.status === 'done') {
            statusClass = 'status-done';
            statusText = statusTitle = 'Đã có';
        }

        const disabled = !needsWork(item);
        const descBadge = DESC_BADGES[getDescState(item)] || { text: 'Unknown', cls: 'status-unknown' };

        return `
            <div class="lang-item">
                <div class="lang-info">
                    <span class="lang-code">${item.code}</span>
                    <div class="lang-text">
                        <span class="lang-name">${displayName}</span>
                        ${item === addingItem ? `<span class="lang-progress" id="langProgress">${progressText}</span>` : ''}
                    </div>
                </div>
                <div class="lang-col"><span class="lang-status ${statusClass}" title="Âm thanh gốc: ${statusTitle}">${statusText}</span></div>
                <div class="lang-col lang-col-desc"><span class="lang-status ${descBadge.cls}" title="Âm thanh mô tả: ${descBadge.text}">${descBadge.text}</span></div>
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

    // Hàng tiêu đề cột Gốc / Mô tả; phần nút để ẩn cho thẳng cột với các dòng bên dưới
    const headerHtml = selectedLangs.length === 0 ? '' : `
        <div class="lang-item lang-head" aria-hidden="true">
            <div class="lang-info"></div>
            <div class="lang-col">Gốc</div>
            <div class="lang-col lang-col-desc">Mô tả</div>
            <div class="lang-actions"><span class="btn btn-add">Thêm</span><span class="btn btn-remove">✕</span></div>
        </div>`;

    container.innerHTML = headerHtml + itemsHtml + extrasHtml;
    document.getElementById('langCount').textContent = selectedLangs.length;

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

    // Chạy tất cả / Auto Fix / Dừng
    [['btnRunAll', false], ['btnAutoFix', true]].forEach(([id, fix]) => {
        document.getElementById(id).addEventListener('click', () => {
            if (isRunningAll) {
                stopRun('Bạn đã bấm Dừng');
                runButton().textContent = '⏳ Đang dừng...';
            } else {
                runAll(fix);
            }
        });
    });

    // Xoá âm thanh lỗi
    document.getElementById('btnDeleteErrorsAuto').addEventListener('click', () => isDeleting ? stopDeleting() : deleteErrorAudios('auto'));
    // Tạm ẩn 2 nút dưới (sidepanel.html), bỏ style="display:none" để dùng lại
    document.getElementById('btnDeleteErrors').addEventListener('click', () => isDeleting ? stopDeleting() : deleteErrorAudios('dialog'));
    document.getElementById('btnDeleteErrorsQuick').addEventListener('click', () => isDeleting ? stopDeleting() : deleteErrorAudios('quick'));

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

    // Chọn file âm thanh mô tả
    document.getElementById('btnPickDescAudio').addEventListener('click', () => {
        document.getElementById('descAudioFile').click();
    });

    document.getElementById('descAudioFile').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        descAudioFile = file;
        document.getElementById('descAudioFileName').textContent = file.name;
        renderLangList(); // Ngôn ngữ đã có âm thanh gốc giờ có thể bổ sung âm thanh mô tả
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

// Kết quả của addDubForLang khi vừa xoá âm thanh mô tả lỗi: chưa thêm gì, cần chạy lại ngôn ngữ này sau
const RETRY_LATER = 'retry-later';

// tabId: tab cố định khi Chạy tất cả; bỏ trống = tab đang mở
// Trả về null nếu thành công, RETRY_LATER nếu vừa xoá âm thanh mô tả lỗi (cần chạy lại sau), hoặc nội dung lỗi.
// Khi Chạy tất cả thì không alert (runAll báo gộp ở cuối).
async function addDubForLang(index, tabId = null) {
    const item = selectedLangs[index];
    const lang = LANGUAGES.find(l => l.code === item.code);

    if (!lang) {
        const msg = `Extension chưa hỗ trợ tự thêm ngôn ngữ ${item.code}. Hãy thêm thủ công trên YouTube Studio.`;
        if (!isRunningAll) alert(msg);
        return msg;
    }

    console.log('Starting addDubForLang for:', item.code, lang.name);

    // Cập nhật trạng thái (bỏ trạng thái YouTube cũ, lần Reload sau sẽ lấy lại; lỗi thì trả lại như cũ)
    const prev = { status: item.status, ytStatus: item.ytStatus, ytText: item.ytText };
    item.status = 'processing';
    item.ytStatus = null;
    item.ytText = '';
    isAdding = true;
    addingItem = item;
    progressText = 'Đang chuẩn bị…';
    updateBusyUI();
    saveSelectedLangs();
    renderLangList();

    const videoId = currentVideoId();
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

        // Gửi file âm thanh gốc và mô tả (nếu đã chọn)
        const audio = await sendAudioFile(tabId, 'main', audioFile);
        const descAudio = await sendAudioFile(tabId, 'desc', descAudioFile);

        if (stopReason) throw new Error(stopReason);

        // Tên ngôn ngữ đúng như trên bảng Bản dịch (nếu đã có trên video) để mở đúng dòng
        const existingRow = await readRowOfLang(tabId, item.code, 0);

        console.log('Sending message to content script...');
        const response = await sendToTab(tabId, {
            action: "add_single_lang",
            langCode: item.code,
            langName: lang.name,
            langNameVn: lang.nameVn || lang.name,
            rowLabel: existingRow ? existingRow.label : '',
            audio: audio,
            descAudio: descAudio,
            skipDescError: isRunningAll && !runFix // Chạy tất cả: âm thanh mô tả lỗi thì bỏ qua, không xoá
        });
        console.log('Response from content script:', response);

        if (!response || !response.success) {
            throw new Error(response ? response.error : 'Không nhận được phản hồi từ trang');
        }

        // Vừa xoá âm thanh mô tả lỗi, chưa thêm gì → trả lại trạng thái cũ, chạy lại sau
        if (response.descState === 'deleted') {
            Object.assign(item, prev.ytStatus ? prev : { status: 'pending' });
            setDescState(item, videoId, 'none');
            if (!isRunningAll) alert(`Đã xoá âm thanh mô tả bị lỗi của ${lang.nameVn || lang.name}. Bấm Thêm lại để thêm âm thanh.`);
            isAdding = false;
            addingItem = null;
            progressText = '';
            updateBusyUI();
            saveSelectedLangs();
            renderLangList();
            return RETRY_LATER;
        }

        // Ghi nhận trạng thái âm thanh mô tả vừa thấy trong hộp ngôn ngữ
        if (response.descState === 'present' || response.descState === 'added') {
            setDescState(item, videoId, 'ok');
        } else if (response.descState === 'skipped' && audioFile) {
            setDescState(item, videoId, 'none'); // Hộp không có dòng âm thanh mô tả
        }

        if (response.onVideo && !response.mainAdded) {
            // Ngôn ngữ đã có trên video → lấy trạng thái thật từ bảng
            const row = await readRowOfLang(tabId, item.code, 0);
            if (!row) throw new Error(`Ngôn ngữ ${item.code} bị khoá trong menu nhưng không thấy trong bảng Bản dịch`);
            applyRowToItem(item, row);
        } else if (response.mainAdded) {
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

        // Chỉ có file mô tả mà ngôn ngữ chưa có âm thanh gốc → hộp tải âm thanh gốc đang mở để chọn thủ công
        if (descAudioFile && !audioFile && !response.mainAdded && response.descState === 'skipped' && !isRunningAll) {
            alert(`${DESC_NEEDS_MAIN_MSG}\n\nHãy chọn file âm thanh gốc trong hộp thoại đang mở trên YouTube Studio và bấm Xuất bản, Cập nhật. Sau đó bấm Thêm lại để bổ sung âm thanh mô tả.`);
        }

        if (response.descState === 'blocked') {
            throw new Error('Menu ⋮ của dòng Audio không có mục Add descriptive audio');
        }
    } catch (e) {
        console.error('Error:', e);
        Object.assign(item, prev.ytStatus ? prev : { status: 'pending' });
        // Chạy tất cả gặp âm thanh mô tả lỗi (content.js bỏ qua, không xoá) → đánh dấu Lỗi
        if (/Âm thanh mô tả bị lỗi/.test(e.message)) setDescState(item, videoId, 'error');
        error = e.message;
        // Đang Chạy tất cả (bỏ qua lỗi / dừng do chuyển tab) thì runAll báo ở cuối, không alert ở đây
        if (!isRunningAll) alert('Lỗi: ' + e.message);
    }

    isAdding = false;
    addingItem = null;
    progressText = '';
    updateBusyUI();
    saveSelectedLangs();
    renderLangList();
    return error;
}

// Dừng "Chạy tất cả": ngắt thao tác đang dở trên trang và không sang ngôn ngữ tiếp theo
function stopRun(reason) {
    if (!isRunningAll || stopReason) return;
    stopReason = reason;
    if (deleteTabId) deleteStopRequested = true; // Đang ở bước Auto Fix (xoá nhanh) thì cũng dừng
    chrome.tabs.sendMessage(runTabId, { action: 'abort', reason: reason }, () => {
        void chrome.runtime.lastError; // Tab có thể đã rời trang - bỏ qua
    });
}

// Chạy lần lượt mọi ngôn ngữ chưa hoàn thành. Ngôn ngữ bị lỗi thì bỏ qua, chạy tiếp; dừng khi chuyển tab / bấm Dừng
// fix = false (Chạy tất cả): bỏ qua ngôn ngữ có âm thanh lỗi, chỉ thêm cho ngôn ngữ chưa có âm thanh gốc / mô tả
// fix = true (Auto Fix): xoá âm thanh lỗi (autoFixBeforeRun) rồi thêm file
async function runAll(fix) {
    if (isBusy()) return;
    const runName = fix ? 'Auto Fix' : 'Chạy tất cả';

    if (!audioFile && !descAudioFile) {
        alert(`Chọn file âm thanh trước khi ${fix ? 'chạy Auto Fix' : 'chạy tất cả'}!`);
        return;
    }
    if (selectedLangs.length === 0) {
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

    runFix = !!fix;
    const btn = runButton();
    const notice = document.getElementById('runNotice');
    isRunningAll = true;
    runTabId = tab.id;
    runWindowId = tab.windowId;
    runVideoId = match[1];
    stopReason = null;
    notice.hidden = false;
    updateBusyUI();

    // BƯỚC AUTO FIX: xoá âm thanh lỗi của các ngôn ngữ trong danh sách (đủ file để thêm lại) trước khi thêm
    let fixText = '';
    if (fix) {
        try {
            fixText = await autoFixBeforeRun(tab, btn);
        } catch (e) {
            if (!stopReason) stopReason = `Lỗi ở bước Auto Fix: ${e.message}`;
        }
    }

    // Chạy tất cả: bỏ qua ngôn ngữ có âm thanh gốc bị lỗi (dùng Auto Fix để xoá rồi thêm lại)
    const errorSkipped = fix || stopReason ? [] : selectedLangs.filter(l => l.ytStatus === 'error' && needsWork(l));
    if (errorSkipped.length) {
        fixText = `\n\n⚠️ Bỏ qua ${errorSkipped.length} ngôn ngữ có âm thanh bị lỗi (bấm Auto Fix để xoá rồi thêm lại):\n${errorSkipped.map(l => `• ${l.code}`).join('\n')}`;
    }

    // Chưa chọn file gốc → chỉ chạy ngôn ngữ đã có âm thanh gốc (để thêm âm thanh mô tả), ngôn ngữ còn lại giữ Chờ
    const pending = selectedLangs.filter(l => needsWork(l) && !errorSkipped.includes(l));
    const queue = stopReason ? [] : (audioFile ? pending : pending.filter(hasMainAudio));
    const noMain = stopReason ? [] : pending.filter(l => !queue.includes(l));
    const noMainText = noMain.length
        ? `\n\n⚠️ ${DESC_NEEDS_MAIN_MSG} Chưa chọn file âm thanh gốc nên đã bỏ qua ${noMain.length} ngôn ngữ chưa có âm thanh gốc (vẫn ở trạng thái Chờ):\n${noMain.map(l => `• ${l.code}`).join('\n')}`
        : '';

    const failed = []; // Ngôn ngữ bị lỗi đã bỏ qua
    const retryLater = []; // Ngôn ngữ vừa xoá âm thanh mô tả lỗi → chạy hết danh sách rồi quay lại thêm
    for (let i = 0; i < queue.length; i++) {
        if (stopReason) break;
        const index = selectedLangs.indexOf(queue[i]);
        if (index === -1) continue; // Đã bị xoá khỏi danh sách giữa chừng

        btn.textContent = `⏹ Dừng (đang chạy ${i + 1}/${queue.length})`;
        const error = await addDubForLang(index, runTabId);
        if (stopReason) break;
        if (error === RETRY_LATER) retryLater.push(queue[i]);
        else if (error) failed.push(`• ${queue[i].code}: ${error}`);

        // Chờ hộp thoại đóng hẳn trước khi sang ngôn ngữ tiếp theo
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Quay lại thêm các ngôn ngữ vừa xoá âm thanh mô tả lỗi
    for (let i = 0; i < retryLater.length; i++) {
        if (stopReason) break;
        const index = selectedLangs.indexOf(retryLater[i]);
        if (index === -1) continue;

        btn.textContent = `⏹ Dừng (thêm lại ${i + 1}/${retryLater.length})`;
        const error = await addDubForLang(index, runTabId);
        if (stopReason) break;
        if (error === RETRY_LATER) failed.push(`• ${retryLater[i].code}: Âm thanh mô tả vẫn bị lỗi sau khi xoá và thêm lại`);
        else if (error) failed.push(`• ${retryLater[i].code}: ${error}`);

        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const reason = stopReason;
    isRunningAll = false;
    runFix = false;
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
        alert(`⛔ Đã dừng ${runName}: ${reason}.\nCác ngôn ngữ chưa chạy vẫn ở trạng thái Chờ, bấm ${runName} để chạy tiếp.${fixText}${failedText}`);
    } else if (queue.length === 0 && !fixText) {
        alert(`Không còn ngôn ngữ nào cần chạy!${noMainText}`);
    } else if (failed.length) {
        alert(`${runName} đã xong.${fixText}${failedText}\n\nBấm ${runName} để thử lại các ngôn ngữ này.${noMainText}`);
    } else if (noMain.length || fixText) {
        alert(`${runName} đã xong.${fixText}${noMainText}`);
    }
}

// Tìm dòng trên bảng Bản dịch của 1 ngôn ngữ trong danh sách (theo mã, không có mã thì theo tên)
function findRowOfItem(rows, item) {
    const lang = LANGUAGES.find(l => l.code === item.code);
    return rows.find(r => r.code === item.code)
        || (lang && rows.find(r => !r.code && (r.name === lang.name || r.name === lang.nameVn)));
}

async function readRowsOfTab(tabId) {
    const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: readTranslationRows,
        args: [null, false]
    });
    return injection.result || [];
}

// Auto Fix trước khi Chạy tất cả: tự động xoá âm thanh lỗi rồi để Chạy tất cả thêm file mới (không hỏi xác nhận).
// Chỉ xét ngôn ngữ có trong danh sách và có dòng trên bảng; mỗi ngôn ngữ mở hộp 1 lần, đọc trạng thái và xoá luôn,
// chỉ xoá khi đã chọn đủ file để thêm lại phần bị xoá:
// - Chính lỗi, mô tả lỗi / không có → xoá âm thanh chính trong hộp (mô tả xoá theo). Cần file gốc (+ file mô tả nếu đang có mô tả)
// - Chính còn / không có, mô tả lỗi → xoá âm thanh mô tả trong hộp. Cần file mô tả (+ file gốc nếu chưa có âm thanh chính)
// - Chính lỗi, mô tả còn → để sau, xoá nhanh ở bảng (giữ mô tả). Cần file gốc
// Thứ tự: xoá trong hộp hết → xoá nhanh (tự tải lại trang sau mỗi lượt) → đọc lại bảng, cập nhật trạng thái danh sách.
// Mỗi ngôn ngữ mở hộp đều được ghi nhận âm thanh mô tả còn tốt hay không, lần sau không cần mở lại.
// Ngôn ngữ lỗi trên bảng nhưng không có trong danh sách: không đụng tới, chỉ báo.
// Trả về đoạn báo cáo để gộp vào thông báo cuối ('' nếu không có gì để báo).
async function autoFixBeforeRun(tab, btn) {
    const videoId = runVideoId;
    try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) {
        console.log('Script injection:', e.message);
    }
    await new Promise(resolve => setTimeout(resolve, 500));

    let rows = await readRowsOfTab(tab.id);

    // Ngôn ngữ lỗi trên bảng nhưng chưa có trong danh sách
    const extraErrors = rows.filter(r => r.status === 'error' && r.name && !selectedLangs.some(item => findRowOfItem([r], item)));

    // Ngôn ngữ cần mở hộp: âm thanh chính lỗi; hoặc có file mô tả mà chưa ghi nhận âm thanh mô tả tốt
    // (âm thanh mô tả không hiện trên bảng). Ngôn ngữ đã ghi nhận đủ từ lần mở trước thì không mở lại.
    const checks = [];
    selectedLangs.forEach(item => {
        const row = findRowOfItem(rows, item);
        if (row && (row.status === 'error' || (descAudioFile && item.descVideoId !== videoId))) checks.push({ item, row });
    });

    const list = (arr, fn) => arr.map(e => `• ${e.name}${fn ? fn(e) : ''}`).join('\n');
    const failed = [], noFile = [], quick = [];
    let mainDone = 0, descDone = 0, quickFailed = [];

    // Dùng lại cơ chế xoá nhanh (theo dõi Dừng / tab rời video)
    deleteTabId = tab.id;
    deleteVideoId = videoId;
    deleteStopRequested = !!stopReason;
    deleteAbortReason = null;
    try {
        for (let i = 0; i < checks.length; i++) {
            if (stopReason) break;
            btn.textContent = `⏹ Dừng (Auto Fix ${i + 1}/${checks.length})`;
            const { item, row } = checks[i];
            const entry = { item, row, name: row.name };
            let response;
            try {
                response = await sendToTab(tab.id, { action: 'auto_fix_lang', langName: row.label || row.name, hasAudio: !!audioFile, hasDesc: !!descAudioFile });
            } catch (e) {
                response = { success: false, error: e.message };
            }
            if (stopReason) break;
            if (response && response.success) {
                // Ghi nhận trạng thái âm thanh mô tả vừa đọc trong hộp: còn tốt → đánh dấu "Mô tả", lúc thêm file sẽ bỏ qua;
                // lỗi / không có / bị xoá theo âm thanh chính → bỏ đánh dấu để thêm lại
                setDescState(item, videoId, response.action === 'main' || response.action === 'desc' ? 'none' : response.desc);
                saveSelectedLangs();
                renderLangList();
            }
            if (!response || !response.success) {
                failed.push(`• ${row.name}: ${response ? response.error : 'Không nhận được phản hồi từ trang'}`);
            } else if (response.action === 'main' || response.action === 'desc') {
                if (response.action === 'main') mainDone++; else descDone++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else if (response.action === 'quick') {
                quick.push(entry);
            } else if (response.action === 'nofile') {
                noFile.push({ ...entry, need: response.need });
            }
        }

        // Xoá qua hộp không làm bảng hiển thị sai nên không cần tải lại trang trước khi xoá nhanh
        if (quick.length && !stopReason) {
            quickFailed = await quickDeletePasses(tab, quick.map(e => ({ name: e.name, label: e.row.label })), btn);
        }
    } finally {
        if (deleteAbortReason && !stopReason) stopReason = deleteAbortReason;
        deleteTabId = null;
        deleteVideoId = null;
        deleteStopRequested = false;
        deleteAbortReason = null;
    }

    const quickDone = quick.length - quickFailed.length;
    const changed = mainDone + descDone + quickDone > 0;

    // Đọc lại bảng để cập nhật trạng thái danh sách trước khi thêm (không tải lại trang: xoá qua hộp không làm bảng hiện sai,
    // còn xoá nhanh thì quickDeletePasses đã tải lại trang sau mỗi lượt)
    if (changed && !stopReason) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        rows = await readRowsOfTab(tab.id);
        selectedLangs.forEach(item => applyRowToItem(item, findRowOfItem(rows, item)));
        saveSelectedLangs();
        renderLangList();
    }

    const allFailed = [...failed, ...quickFailed];
    let report = '';
    if (changed || quick.length) report += `\n\nAuto Fix: đã xoá trong hộp ngôn ngữ ${mainDone + descDone} (âm thanh chính ${mainDone}, âm thanh mô tả ${descDone}), xoá nhanh ${quickDone}/${quick.length}.`;
    if (allFailed.length) report += `\n\n⚠️ Auto Fix xoá không được:\n${allFailed.join('\n')}`;
    if (noFile.length) report += `\n\nKhông xoá vì thiếu file để thêm lại:\n${list(noFile, e => ` (cần ${e.need})`)}`;
    if (extraErrors.length) report += `\n\nLỗi trên video nhưng chưa có trong danh sách (không đụng tới, thêm vào danh sách rồi chạy lại nếu cần):\n${list(extraErrors)}`;
    return report;
}

// Xoá âm thanh lỗi (Removed / Processing failed) của mọi ngôn ngữ trên video đang mở.
// Đọc bảng Bản dịch, hỏi xác nhận, rồi xoá lần lượt; chỉ xoá âm thanh, giữ ngôn ngữ và phụ đề.
// mode: 'dialog' = xoá qua hộp ngôn ngữ, 'quick' = xoá ngay ở bảng (nút ▾ của ô Audio),
// 'auto' = tự chọn theo từng ngôn ngữ (xem autoDeletePasses)
async function deleteErrorAudios(mode) {
    const quick = mode === 'quick';
    const auto = mode === 'auto';
    if (isBusy()) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/studio\.youtube\.com\/video\/[a-zA-Z0-9_-]+\/translations/.test(tab.url || '')) {
        alert('Hãy mở trang Translations của video trên YouTube Studio trước!');
        return;
    }

    let rows;
    try {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: readTranslationRows,
            args: [null, false]
        });
        rows = injection.result || [];
    } catch (e) {
        alert('Lỗi: ' + e.message);
        return;
    }

    // Tự động: âm thanh mô tả không hiện trên bảng (kể cả dòng chưa có âm thanh chính "–") → phải mở hộp của mọi ngôn ngữ để kiểm tra
    const errors = auto
        ? rows.filter(r => r.name)
        : rows.filter(r => r.status === 'error' && r.name);
    if (errors.length === 0) {
        alert(auto ? 'Video chưa có ngôn ngữ nào.' : 'Video không có âm thanh lỗi nào.');
        return;
    }
    const mainErrors = errors.filter(r => r.status === 'error');
    const confirmMsg = auto
        ? `Kiểm tra ${errors.length} ngôn ngữ và xoá âm thanh lỗi (chính / mô tả)? (Giữ nguyên ngôn ngữ và phụ đề)\n\nÂm thanh chính đang lỗi:\n${mainErrors.length ? mainErrors.map(r => `• ${r.name}: ${r.text}`).join('\n') : '(không có)'}`
        : `Xoá âm thanh lỗi của ${errors.length} ngôn ngữ? (Giữ nguyên ngôn ngữ và phụ đề)\n\n${errors.map(r => `• ${r.name}: ${r.text}`).join('\n')}`;
    if (!confirm(confirmMsg)) {
        return;
    }

    const btn = document.getElementById({ auto: 'btnDeleteErrorsAuto', quick: 'btnDeleteErrorsQuick', dialog: 'btnDeleteErrors' }[mode]);
    const btnLabel = btn.textContent;
    btn.dataset.running = '1';
    deleteStopRequested = false;
    deleteAbortReason = null;
    deleteTabId = tab.id;
    deleteVideoId = tab.url.match(/\/video\/([a-zA-Z0-9_-]+)/)[1];
    isDeleting = true;
    updateBusyUI();

    let failed = [];
    let notRun = []; // Ngôn ngữ chưa xoá vì đã bấm Dừng
    let stopped = false;
    let abortReason = null;
    let autoResult = null;
    try {
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        } catch (e) {
            console.log('Script injection:', e.message);
        }
        await new Promise(resolve => setTimeout(resolve, 500));

        if (auto) {
            autoResult = await autoDeletePasses(tab, errors, btn);
            failed = autoResult.failed;
            notRun = autoResult.notRun;
        } else if (quick) {
            failed = await quickDeletePasses(tab, errors, btn);
        } else {
            for (let i = 0; i < errors.length; i++) {
                if (deleteStopRequested || !await isTabOnVideo(tab.id, deleteVideoId)) {
                    notRun = errors.slice(i);
                    break;
                }
                setDeleteProgress(btn, `${i + 1}/${errors.length}`);
                try {
                    const response = await sendToTab(tab.id, { action: 'delete_error_audio', langName: errors[i].label || errors[i].name });
                    if (!response || !response.success) {
                        throw new Error(response ? response.error : 'Không nhận được phản hồi từ trang');
                    }
                } catch (e) {
                    failed.push(`• ${errors[i].name}: ${e.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    } finally {
        stopped = deleteStopRequested;
        abortReason = deleteAbortReason;
        isDeleting = false;
        deleteStopRequested = false;
        deleteAbortReason = null;
        deleteTabId = null;
        deleteVideoId = null;
        delete btn.dataset.running;
        btn.textContent = btnLabel;
        updateBusyUI();
    }

    await syncStatus(true);

    // Tự dừng vì tab rời video: không biết chắc ngôn ngữ đang xoá dở đã xoá xong chưa → nhắc mở lại video kiểm tra
    if (abortReason) {
        const unknown = [...failed, ...notRun.map(r => `• ${r.name}`)];
        alert(`⛔ Đã dừng xoá: ${abortReason}.\nHãy mở lại trang Translations của video ${tab.url.match(/\/video\/([a-zA-Z0-9_-]+)/)[1]} để kiểm tra.${unknown.length ? `\n\nChưa xác nhận đã xoá:\n${unknown.join('\n')}` : ''}`);
        return;
    }

    const stoppedText = stopped ? '⛔ Đã dừng. ' : '';
    if (auto) {
        const r = autoResult;
        const notRunText = notRun.length ? `\n\nChưa kiểm tra / chưa xoá:\n${notRun.map(x => `• ${x.name}`).join('\n')}` : '';
        const summary = `Xoá qua hộp ngôn ngữ: ${r.dialogDone} (âm thanh chính ${r.mainDone}, âm thanh mô tả ${r.descDone})\nXoá nhanh: ${r.quickDone}/${r.quickCount}`;
        alert(failed.length || notRun.length || stopped
            ? `${stoppedText}${summary}${failed.length ? `\n\n⚠️ Còn lỗi:\n${failed.join('\n')}` : ''}${notRunText}`
            : (r.dialogDone + r.quickDone ? `✅ ${summary}` : '✅ Không có âm thanh lỗi nào.'));
        return;
    }
    const done = errors.length - failed.length - notRun.length;
    const notRunText = notRun.length ? `\n\nChưa xoá:\n${notRun.map(r => `• ${r.name}`).join('\n')}` : '';
    alert(failed.length || notRun.length || stopped
        ? `${stoppedText}Đã xoá âm thanh lỗi của ${done}/${errors.length} ngôn ngữ.${failed.length ? `\n\n⚠️ Còn lỗi:\n${failed.join('\n')}` : ''}${notRunText}`
        : `✅ Đã xoá âm thanh lỗi của ${done} ngôn ngữ.`);
}

// Tab đang xoá rời khỏi video: ngắt luôn thao tác đang dở trên trang và không xoá tiếp
function abortDeleting(reason) {
    if (deleteAbortReason) return;
    deleteAbortReason = reason;
    stopDeleting();
    chrome.tabs.sendMessage(deleteTabId, { action: 'abort', reason: reason }, () => {
        void chrome.runtime.lastError; // Tab có thể đã rời trang - bỏ qua
    });
}

// Tab vẫn đang ở trang Translations của video đang xoá không
async function isTabOnVideo(tabId, videoId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if ((tab.url || '').includes(`/video/${videoId}/translations`)) return true;
    } catch (e) {
        // Tab đã đóng
    }
    abortDeleting('Trang YouTube Studio đã chuyển sang video / trang khác hoặc đã đóng');
    return false;
}

// Bấm Dừng khi đang xoá: xoá xong ngôn ngữ đang làm dở thì dừng
function stopDeleting() {
    if (deleteStopRequested) return;
    deleteStopRequested = true;
    const btn = document.querySelector('[data-running="1"]');
    if (btn) btn.textContent = '⏳ Đang dừng...';
    updateBusyUI();
}

function setDeleteProgress(btn, text) {
    if (!deleteStopRequested) btn.textContent = `⏹ Dừng (${text})`;
}

// Tự động: mở hộp từng ngôn ngữ, xoá ngay trong hộp những ngôn ngữ cần xoá qua hộp
// (chính lỗi + mô tả lỗi/không có → xoá chính; chính tốt + mô tả lỗi → xoá mô tả).
// Ngôn ngữ chính lỗi nhưng mô tả còn tốt → để dành, xoá hộp xong hết mới xoá nhanh ở bảng (giữ âm thanh mô tả).
async function autoDeletePasses(tab, langs, btn) {
    const videoId = tab.url.match(/\/video\/([a-zA-Z0-9_-]+)/)[1];
    const failed = [];
    let notRun = [];
    const quickList = [];
    let mainDone = 0, descDone = 0;

    for (let i = 0; i < langs.length; i++) {
        if (deleteStopRequested || !await isTabOnVideo(tab.id, videoId)) {
            notRun = langs.slice(i);
            break;
        }
        setDeleteProgress(btn, `hộp ngôn ngữ ${i + 1}/${langs.length}`);
        try {
            const response = await sendToTab(tab.id, { action: 'delete_error_audio_auto', langName: langs[i].label || langs[i].name });
            if (!response || !response.success) {
                throw new Error(response ? response.error : 'Không nhận được phản hồi từ trang');
            }
            // Ghi nhận trạng thái âm thanh mô tả cho ngôn ngữ có trong danh sách
            const item = selectedLangs.find(it => findRowOfItem([langs[i]], it));
            if (item && response.result !== 'none') {
                setDescState(item, videoId, response.result === 'quick' ? 'ok' : 'none');
                saveSelectedLangs();
                renderLangList();
            }
            if (response.result === 'quick') quickList.push(langs[i]);
            else if (response.result === 'main') mainDone++;
            else if (response.result === 'desc') descDone++;
            if (response.result === 'main' || response.result === 'desc') {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (e) {
            failed.push(`• ${langs[i].name}: ${e.message}`);
        }
    }

    let quickFailed = [];
    if (quickList.length) {
        if (deleteStopRequested || deleteAbortReason) {
            notRun = [...notRun, ...quickList];
        } else if (!await isTabOnVideo(tab.id, videoId)) {
            notRun = [...notRun, ...quickList];
        } else {
            // Xoá qua hộp không làm bảng hiển thị sai nên không cần tải lại trang trước khi xoá nhanh
            try {
                quickFailed = await quickDeletePasses(tab, quickList, btn);
            } catch (e) {
                quickFailed = quickList.map(r => `• ${r.name}: ${e.message}`);
            }
        }
    }

    const quickDone = notRun.some(r => quickList.includes(r)) ? 0 : quickList.length - quickFailed.length;
    return {
        failed: [...failed, ...quickFailed],
        notRun,
        mainDone,
        descDone,
        dialogDone: mainDone + descDone,
        quickCount: quickList.length,
        quickDone
    };
}

// Xoá nhanh theo lượt: mỗi lượt bấm xoá lần lượt các ngôn ngữ còn lỗi (không thấy nút thì bỏ qua),
// hết lượt mới tải lại trang và đọc lại bảng để tìm ngôn ngữ còn sót. Dừng khi hết sót hoặc lượt sau không xoá thêm được.
// Trả về danh sách lỗi của các ngôn ngữ vẫn còn sót.
const QUICK_DELETE_MAX_PASSES = 3;

async function quickDeletePasses(tab, errors, btn) {
    const videoId = tab.url.match(/\/video\/([a-zA-Z0-9_-]+)/)[1];
    const lastError = {};
    let remaining = errors;

    for (let pass = 1; pass <= QUICK_DELETE_MAX_PASSES && remaining.length > 0; pass++) {
        for (let i = 0; i < remaining.length; i++) {
            if (deleteStopRequested || !await isTabOnVideo(tab.id, videoId)) break;
            setDeleteProgress(btn, `lượt ${pass}: ${i + 1}/${remaining.length}`);
            try {
                const response = await sendToTab(tab.id, { action: 'delete_error_audio_quick', langName: remaining[i].label || remaining[i].name });
                if (!response || !response.success) {
                    throw new Error(response ? response.error : 'Không nhận được phản hồi từ trang');
                }
            } catch (e) {
                lastError[remaining[i].name] = e.message;
            }
        }

        // Tab đã rời video → không tải lại (sẽ tải lại nhầm trang khác), báo các ngôn ngữ chưa xác nhận
        if (deleteAbortReason || !await isTabOnVideo(tab.id, videoId)) {
            return remaining.map(r => `• ${r.name}`);
        }

        // Đã dừng vẫn tải lại trang 1 lần để bảng hiện đúng và biết ngôn ngữ nào còn lỗi
        setDeleteProgress(btn, 'tải lại trang...');
        try {
            await reloadTranslationsTab(tab.id, videoId);
            const [injection] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: readTranslationRows,
                args: [null, false]
            });
            const stillError = new Set((injection.result || []).filter(r => r.status === 'error').map(r => r.name));
            const next = remaining.filter(r => stillError.has(r.name));
            const progressed = next.length < remaining.length;
            remaining = next;
            if (!progressed || deleteStopRequested) break;
        } catch (e) {
            return remaining.map(r => `• ${r.name}: ${e.message}`);
        }
    }

    return remaining.map(r => `• ${r.name}: ${lastError[r.name] || (deleteStopRequested ? 'Chưa xoá (đã dừng)' : 'Vẫn còn lỗi sau khi xoá')}`);
}

// Tải lại trang Translations, chờ bảng tải xong rồi inject lại content.js
async function reloadTranslationsTab(tabId, videoId) {
    await new Promise(resolve => {
        const onUpdated = (id, changeInfo) => {
            if (id === tabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.reload(tabId);
    });
    const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: readTranslationRows,
        args: [videoId, true]
    });
    if (injection.result === null) {
        throw new Error('Bảng Bản dịch chưa tải xong sau khi tải lại trang');
    }
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
}

// Base64 chia phần, bội số của 4 để mỗi phần tự giải mã được
const AUDIO_CHUNK_SIZE = 8 * 1024 * 1024;

const bridgeChannel = new BroadcastChannel('ytdub-bridge');

// Gửi thẳng file gốc qua trạm trung chuyển trong tab (bridge.html) - không sao chép nội dung file.
// Trả về true nếu trang đã nhận và chép xong, false nếu trạm không trả lời hoặc chép lỗi (khi đó dùng cách gửi base64)
async function sendViaBridge(tabId, slot, key, file) {
    let token = null;
    for (let i = 0; i < 10 && !token; i++) {
        const res = await sendToTab(tabId, { action: 'bridge_token' });
        token = res && res.token;
        if (!token) await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!token) return false;

    const id = `${Date.now()}-${Math.random()}`;
    return new Promise((resolve) => {
        const finish = (ok) => {
            clearTimeout(timer);
            bridgeChannel.removeEventListener('message', onAck);
            resolve(ok);
        };
        // Trạm phải báo đã nhận trong 5 giây; sau đó chờ trang chép file vào bộ nhớ (file dài trên máy chậm có thể lâu)
        let timer = setTimeout(() => finish(false), 5000);
        const onAck = (e) => {
            if (!e.data || e.data.token !== token || e.data.ack !== id) return;
            if (e.data.received) {
                clearTimeout(timer);
                timer = setTimeout(() => finish(false), 5 * 60000);
                setProgress(`Đang chép file ${slot === 'desc' ? 'âm thanh mô tả' : 'âm thanh gốc'} vào trang…`);
            } else if (e.data.done) {
                finish(true);
            } else if (e.data.error) {
                console.log('Trang không chép được file:', e.data.error);
                finish(false);
            }
        };
        bridgeChannel.addEventListener('message', onAck);
        bridgeChannel.postMessage({ token: token, id: id, slot: slot, key: key, file: file });
    });
}

// Gửi file sang trang: ưu tiên trạm trung chuyển, không được thì gửi base64 theo từng phần
// (Chrome giới hạn 64MiB mỗi tin nhắn). Trả về thông tin file, hoặc null nếu chưa chọn
async function sendAudioFile(tabId, slot, file) {
    if (!file) return null;
    // Trang đã giữ đúng file này từ ngôn ngữ trước → không gửi lại (file dài gửi mỗi lần rất chậm)
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    const check = await sendToTab(tabId, { action: 'audio_has', slot: slot, key: key });
    const label = slot === 'desc' ? 'âm thanh mô tả' : 'âm thanh gốc';
    if (!check || !check.has) {
        setProgress(`Đang chuyển file ${label} sang trang…`);
        if (await sendViaBridge(tabId, slot, key, file)) {
            console.log('Đã gửi file trực tiếp qua trạm trung chuyển:', file.name);
            return { name: file.name, type: file.type, size: file.size, key: key };
        }
        console.log('Trạm trung chuyển không trả lời - gửi base64');
        setProgress(`Đang đọc file ${label} (dự phòng)…`);
        const data = await readFileAsBase64(file);
        await sendToTab(tabId, { action: 'audio_reset', slot: slot });
        const total = Math.ceil(data.length / AUDIO_CHUNK_SIZE);
        for (let i = 0; i < data.length; i += AUDIO_CHUNK_SIZE) {
            setProgress(`Đang gửi file ${label} sang trang (dự phòng)… ${i / AUDIO_CHUNK_SIZE + 1}/${total}`);
            await sendToTab(tabId, { action: 'audio_chunk', slot: slot, data: data.slice(i, i + AUDIO_CHUNK_SIZE) });
        }
        await sendToTab(tabId, { action: 'audio_commit', slot: slot, key: key, name: file.name, type: file.type });
    }
    return { name: file.name, type: file.type, size: file.size, key: key };
}

// Cập nhật dòng tiến trình của ngôn ngữ đang thêm (chỉ sửa chữ, không vẽ lại cả danh sách)
function setProgress(text) {
    if (!isAdding) return;
    progressText = text;
    const el = document.getElementById('langProgress');
    if (el) el.textContent = text;
}

// Content script báo bước đang làm trên YouTube Studio
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'dub_progress') setProgress(request.text);
});

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

// Khung "Có gì mới": background đánh dấu khi extension vừa cập nhật, hiện tới khi người dùng bấm ✕
function showWhatsNew() {
    const box = document.getElementById('whatsNew');
    const version = chrome.runtime.getManifest().version;
    chrome.storage.local.get(['whatsNewVersion'], (result) => {
        box.hidden = result.whatsNewVersion !== version;
    });
    document.getElementById('btnCloseWhatsNew').addEventListener('click', () => {
        box.hidden = true;
        chrome.storage.local.remove('whatsNewVersion');
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
            // Tên đúng như hiện trên bảng (ngôn ngữ tiêu đề & mô tả có thêm hậu tố, vd "Spanish (Mexico) (title and description language)")
            label: nameEl ? nameEl.textContent.trim() : '',
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
