// Helper function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Message handler function
function handleMessage(request, _sender, sendResponse) {
    if (request.action === "add_single_lang") {
        addSingleLanguage(request.langCode, request.langName, request.langNameVn, request.audio, request.descAudio)
            .then((result) => sendResponse({ success: true, ...(result || {}) }))
            .catch((error) => {
                console.error(error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Keep channel open for async response
    }
    
    if (request.action === "delete_error_audio") {
        deleteErrorAudio(request.langName)
            .then(() => sendResponse({ success: true }))
            .catch((error) => {
                console.error(error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    // Nhận file âm thanh theo từng phần base64 từ side panel (slot: 'main' = âm thanh gốc, 'desc' = âm thanh mô tả)
    if (request.action === "audio_reset") {
        window.manualDubAudioParts = window.manualDubAudioParts || {};
        window.manualDubAudioParts[request.slot] = [];
        sendResponse({ success: true });
        return;
    }

    if (request.action === "audio_chunk") {
        const bin = atob(request.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        window.manualDubAudioParts[request.slot].push(bytes);
        sendResponse({ success: true });
        return;
    }

    // Side panel yêu cầu dừng (người dùng chuyển tab / rời trang)
    if (request.action === "abort") {
        window.manualDubAbort = request.reason || 'Đã dừng';
        sendResponse({ success: true });
        return;
    }
}

// Ném lỗi nếu side panel đã yêu cầu dừng
function checkAbort() {
    if (window.manualDubAbort) {
        throw new Error(window.manualDubAbort);
    }
}

// Remove old listener if exists, then add new one
if (window.manualDubHelperLoaded) {
    console.log('YT Dub Uploader: Re-registering listener');
    try {
        chrome.runtime.onMessage.removeListener(window.manualDubMessageHandler);
    } catch (e) {
        // Ignore if listener doesn't exist
    }
}

window.manualDubMessageHandler = handleMessage;
chrome.runtime.onMessage.addListener(handleMessage);
window.manualDubHelperLoaded = true;

// Trả về { onVideo, mainAdded, descState }
// onVideo: ngôn ngữ đã có trên video từ trước (mở hộp ngôn ngữ từ bảng Bản dịch)
// descState: 'present' (đã có) / 'added' (vừa thêm) / 'blocked' (menu ⋮ không có Add descriptive audio) / 'skipped' (không làm)
async function addSingleLanguage(code, name, nameVn, audio, descAudio) {
    console.log(`Adding language: ${code} - ${nameVn}`);
    window.manualDubAbort = null;

    // BƯỚC 0: Đóng hộp thoại / menu còn mở từ lần chạy dở trước
    await closeOpenDialogs();
    
    // BƯỚC 1: Click "Add language" - click vào button bên trong
    const btnAddLang = await waitForElement(() => document.querySelector('#add-translations-button'));
    if (!btnAddLang) {
        throw new Error('Không tìm thấy nút Add language');
    }

    // Click vào button thực sự bên trong ytcp-button
    const innerBtn1 = btnAddLang.querySelector('button') || btnAddLang;
    innerBtn1.click();
    console.log('Clicked Add language button');

    // Chờ danh sách ngôn ngữ hiện ra
    const listShown = await waitFor(() =>
        [...document.querySelectorAll('tp-yt-paper-item[test-id]')].some(isVisible), TIMEOUT);
    if (!listShown) {
        throw new Error('Danh sách ngôn ngữ không hiện ra');
    }
    await sleep(SETTLE);

    // BƯỚC 2: Tìm và chọn ngôn ngữ theo test-id (code)
    const langItems = document.querySelectorAll('tp-yt-paper-item[test-id]');
    let found = false;
    let onVideo = false;
    
    console.log(`Looking for language: ${code}, found ${langItems.length} items`);
    
    const isDisabled = (item) => item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true';

    // Tìm theo test-id
    for (const item of langItems) {
        const testId = item.getAttribute('test-id');
        if (testId === code) {
            // Mục bị khoá = ngôn ngữ đã có trên video → mở hộp ngôn ngữ từ bảng Bản dịch để bổ sung phần còn thiếu
            if (isDisabled(item)) {
                const textEl = item.querySelector('yt-formatted-string.item-text');
                const displayName = (textEl ? textEl.textContent : item.textContent).trim();
                await closeOpenDialogs();
                await openExistingLanguage(displayName, name, nameVn);
                onVideo = true;
            } else {
                item.click();
            }
            found = true;
            console.log(`Found and clicked: ${code}`);
            break;
        }
    }

    // Nếu không tìm thấy theo test-id, thử tìm theo tên
    if (!found) {
        for (const item of langItems) {
            if (isDisabled(item)) continue;
            const textEl = item.querySelector('yt-formatted-string.item-text');
            if (textEl) {
                const text = textEl.textContent.trim().toLowerCase();
                if (text.includes(name.toLowerCase())) {
                    item.click();
                    found = true;
                    console.log(`Found by name: ${name}`);
                    break;
                }
            }
        }
    }
    
    if (!found) {
        throw new Error(`Không tìm thấy ngôn ngữ: ${nameVn} (${code})`);
    }

    // BƯỚC 3: Chờ hộp ngôn ngữ hiện dòng Audio
    const audioRowShown = await waitFor(() =>
        isVisible(document.querySelector('#language-details-source-label-audio')), TIMEOUT);
    if (!audioRowShown) {
        throw new Error('Hộp ngôn ngữ không hiện ra');
    }
    await sleep(SETTLE);

    // BƯỚC 4: Dòng Audio còn nút "Add" = chưa có âm thanh gốc
    let mainAdded = false;
    const btnAddDub = [...document.querySelectorAll('#language-details-text-button-audio, #language-details-text-button-dub')].find(isVisible);
    if (btnAddDub) {
        clickButton(btnAddDub);
        console.log('Clicked Add Dub - Dialog đã mở, bạn có thể chọn file');

        // Chưa chọn file gốc → để hộp tải mở cho người dùng tự chọn
        if (!audio) {
            showNotification(nameVn, code);
            return { onVideo, mainAdded, descState: 'skipped' };
        }
        await uploadAudio('main', audio);
        mainAdded = true;
    }

    // BƯỚC 5: Âm thanh mô tả - chỉ thêm được qua menu ⋮ của dòng Audio sau khi đã có âm thanh gốc
    let descState = 'skipped';
    if (isVisible(document.querySelector('#language-details-source-label-descriptive-audio'))) {
        descState = 'present';
        console.log('Đã có âm thanh mô tả');
    } else if (descAudio) {
        descState = await addDescriptiveAudio(descAudio);
    }

    // BƯỚC 6: Có thay đổi thì bấm Cập nhật, không thì đóng hộp ngôn ngữ
    if (mainAdded || descState === 'added') {
        await clickUpdate();
    } else {
        await closeOpenDialogs();
    }

    // Hiển thị notification
    showNotification(nameVn, code);
    return { onVideo, mainAdded, descState };
}

// Mở hộp ngôn ngữ của 1 ngôn ngữ đã có trên video bằng cách bấm tên ở bảng Bản dịch
async function openExistingLanguage(displayName, name, nameVn) {
    const names = [displayName, name, nameVn].filter(Boolean).map(n => n.trim().toLowerCase());
    const btn = [...document.querySelectorAll('ytgn-video-translation-row .language-display-name')]
        .find(el => names.includes(el.textContent.trim().toLowerCase()));
    if (!btn) {
        throw new Error(`Ngôn ngữ ${nameVn} bị khoá trong menu nhưng không thấy trong bảng Bản dịch`);
    }
    btn.click();
    console.log('Mở hộp ngôn ngữ đã có:', displayName);
}

// Xoá âm thanh lỗi (Removed / Processing failed) của 1 ngôn ngữ, giữ nguyên ngôn ngữ và phụ đề:
// mở hộp ngôn ngữ từ bảng Bản dịch → menu ⋮ của dòng Audio → Delete → Cập nhật
async function deleteErrorAudio(langName) {
    console.log(`Deleting error audio: ${langName}`);
    window.manualDubAbort = null;

    await closeOpenDialogs();
    await openExistingLanguage(langName, langName, langName);

    const audioRowShown = await waitFor(() =>
        isVisible(document.querySelector('#language-details-source-label-audio')), TIMEOUT);
    if (!audioRowShown) {
        throw new Error('Hộp ngôn ngữ không hiện ra');
    }
    await sleep(SETTLE);

    const btnMore = await waitForElement(() => {
        const el = document.querySelector('#language-details-more-options-button-audio');
        return isVisible(el) ? el : null;
    });
    if (!btnMore) {
        throw new Error('Không tìm thấy nút ⋮ ở dòng Audio');
    }
    clickButton(btnMore);

    const menuItem = await waitForElement(() => {
        const el = document.querySelector('tp-yt-paper-item[test-id="delete_dubbed_audio"]');
        return isVisible(el) ? el : null;
    }, 3000);
    if (!menuItem) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        await sleep(SETTLE);
        await closeOpenDialogs();
        throw new Error('Menu ⋮ của dòng Audio không có mục Delete');
    }
    menuItem.click();
    console.log('Clicked Delete');

    // Nếu YouTube hỏi xác nhận xoá thì bấm đồng ý
    const audioGone = () => !isVisible(document.querySelector('#language-details-source-label-audio'))
        || isVisible(document.querySelector('#language-details-text-button-audio'));
    const deleteConfirm = () => [...document.querySelectorAll('ytcp-confirmation-dialog #confirm-button')]
        .find(el => isVisible(el) && !el.closest('#ytgn-save-changes-confirmation-dialog'));
    await waitFor(() => audioGone() || deleteConfirm(), 5000);
    if (deleteConfirm()) {
        clickButton(deleteConfirm());
        console.log('Đã xác nhận xoá');
    }

    const gone = await waitFor(audioGone, TIMEOUT);
    if (!gone) {
        throw new Error('Âm thanh chưa bị xoá khỏi hộp ngôn ngữ');
    }
    await sleep(SETTLE);

    // Có thay đổi chưa lưu thì bấm Cập nhật, không thì đóng hộp ngôn ngữ
    const btnUpdate = document.querySelector('ytcp-button.ytgn-language-dialog-update');
    if (isVisible(btnUpdate) && !btnUpdate.hasAttribute('disabled')) {
        await clickUpdate();
    } else {
        await closeOpenDialogs();
    }

    showNotification(`Đã xoá âm thanh lỗi`, langName);
}

// Menu ⋮ của dòng Audio → "Add descriptive audio" → tải file mô tả
async function addDescriptiveAudio(descAudio) {
    const btnMore = await waitForElement(() => {
        const el = document.querySelector('#language-details-more-options-button-audio');
        return isVisible(el) ? el : null;
    });
    if (!btnMore) {
        throw new Error('Không tìm thấy nút ⋮ ở dòng Audio');
    }
    clickButton(btnMore);

    const menuItem = await waitForElement(() => {
        const el = document.querySelector('tp-yt-paper-item[test-id="add_descriptive_audio_selection"]');
        return isVisible(el) ? el : null;
    }, 3000);
    if (!menuItem) {
        // Menu không có mục này thì bỏ qua
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        await sleep(SETTLE);
        console.log('Menu không có Add descriptive audio');
        return 'blocked';
    }
    menuItem.click();
    console.log('Clicked Add descriptive audio');

    await uploadAudio('desc', descAudio);

    const shown = await waitFor(() =>
        isVisible(document.querySelector('#language-details-source-label-descriptive-audio')), TIMEOUT);
    if (!shown) {
        throw new Error('Dòng Descriptive audio không hiện sau khi Xuất bản');
    }
    return 'added';
}

// Thời gian chờ tối đa cho mỗi phần tử, và khoảng nghỉ ngắn sau khi phần tử hiện ra
// (dùng var vì content.js được inject lại mỗi lần bấm - const/let sẽ lỗi khai báo trùng)
var TIMEOUT = 15000;
var SETTLE = 300;

async function waitFor(check, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        checkAbort();
        if (check()) return true;
        await sleep(200);
    }
    return false;
}

async function waitForElement(find, timeout = TIMEOUT) {
    let el = null;
    await waitFor(() => (el = find()), timeout);
    return el || null;
}

function isVisible(el) {
    return !!el && el.offsetParent !== null;
}

function clickButton(el) {
    (el.querySelector('button') || el).click();
}

// Đóng lần lượt từ trong ra ngoài: menu chọn ngôn ngữ → hộp tải âm thanh → hộp ngôn ngữ
async function closeOpenDialogs() {
    const menuOpen = () => [...document.querySelectorAll('tp-yt-paper-item[test-id]')].some(isVisible);
    if (menuOpen()) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        await waitFor(() => !menuOpen(), 3000);
        console.log('Đã đóng menu chọn ngôn ngữ còn mở');
    }

    const audioCancel = document.querySelector('ytgn-audio-upload-dialog #cancel-button');
    if (isVisible(audioCancel)) {
        clickButton(audioCancel);
        await waitFor(() => !isVisible(audioCancel), 3000);
        console.log('Đã đóng hộp tải âm thanh còn mở');
    }

    const langCancel = document.querySelector('ytcp-icon-button.ytgn-language-dialog-cancel');
    const saveConfirm = () => document.querySelector('ytcp-confirmation-dialog#ytgn-save-changes-confirmation-dialog #confirm-button');
    if (isVisible(langCancel)) {
        clickButton(langCancel);
        await waitFor(() => !isVisible(langCancel) || isVisible(saveConfirm()), 3000);

        // Hiện "Lưu và tiếp tục?" = âm thanh đã Xuất bản nhưng chưa Cập nhật → bấm "Lưu nội dung thay đổi"
        if (isVisible(saveConfirm())) {
            clickButton(saveConfirm());
            await waitFor(() => !isVisible(saveConfirm()) && !isVisible(langCancel), TIMEOUT);
            console.log('Đã Lưu nội dung thay đổi của hộp ngôn ngữ dở dang');
        } else {
            console.log('Đã đóng hộp ngôn ngữ còn mở');
        }
    }

    if (menuOpen() || isVisible(audioCancel) || isVisible(langCancel) || isVisible(saveConfirm())) {
        throw new Error('Không đóng được hộp thoại đang mở trên YouTube Studio');
    }
    await sleep(SETTLE);
}

async function uploadAudio(slot, audio) {
    // Chờ hộp "Âm thanh bằng..." hiện ra
    const dialogShown = await waitFor(() =>
        isVisible(document.querySelector('ytgn-audio-upload-dialog #upload-button')), TIMEOUT);
    if (!dialogShown) {
        throw new Error('Hộp tải âm thanh không hiện ra');
    }
    await sleep(SETTLE);

    const input = document.querySelector('ytgn-audio-upload-dialog #audio-file-loader');
    if (!input) {
        throw new Error('Không tìm thấy ô chọn file âm thanh');
    }

    // Ghép lại File từ các phần đã nhận
    const parts = window.manualDubAudioParts || {};
    const file = new File(parts[slot] || [], audio.name, { type: audio.type || 'audio/mpeg' });
    parts[slot] = [];

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('Đã gán file:', audio.name);

    // Chờ tên file hiện trong hộp thoại rồi mới bấm Xuất bản
    const shown = await waitFor(() => {
        const el = document.querySelector('ytgn-audio-upload-dialog .file-name');
        return el && el.textContent.includes(audio.name);
    }, 10000);
    if (!shown) {
        throw new Error(`Tên file ${audio.name} không hiện trong hộp thoại`);
    }
    await sleep(1500);
    checkAbort();

    const btnPublish = document.querySelector('ytgn-audio-upload-dialog #publish-button');
    if (!btnPublish || btnPublish.hasAttribute('disabled')) {
        throw new Error('Nút Xuất bản chưa bấm được');
    }
    (btnPublish.querySelector('button') || btnPublish).click();
    console.log('Clicked Xuất bản');

    // Chờ hộp tải đóng lại
    const closed = await waitFor(() => !isVisible(document.querySelector('ytgn-audio-upload-dialog #publish-button')), 60000);
    if (!closed) {
        throw new Error('Hộp tải âm thanh chưa đóng sau 60 giây');
    }
    await sleep(SETTLE);
}

async function clickUpdate() {
    // Chờ nút Cập nhật của hộp ngôn ngữ bật lên (sau khi âm thanh "Đã xuất bản") rồi bấm
    const btnUpdate = document.querySelector('ytcp-button.ytgn-language-dialog-update');
    if (!btnUpdate) {
        throw new Error('Không tìm thấy nút Cập nhật');
    }
    const ready = await waitFor(() => !btnUpdate.hasAttribute('disabled'), 60000);
    if (!ready) {
        throw new Error('Nút Cập nhật chưa bật sau 60 giây');
    }
    await sleep(1000);
    checkAbort();
    (btnUpdate.querySelector('button') || btnUpdate).click();
    console.log('Clicked Cập nhật');

    const langCancel = document.querySelector('ytcp-icon-button.ytgn-language-dialog-cancel');
    await waitFor(() => !isVisible(langCancel), TIMEOUT);
}

function showNotification(langName, code) {
    let notif = document.getElementById('manual-dub-notif');
    if (!notif) {
        notif = document.createElement('div');
        notif.id = 'manual-dub-notif';
        document.body.appendChild(notif);
    }
    
    notif.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1a73e8;
        color: white;
        padding: 10px 16px;
        border-radius: 6px;
        z-index: 99999;
        font-family: Arial, sans-serif;
        font-size: 13px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        opacity: 1;
        transition: opacity 0.3s;
    `;
    
    notif.textContent = `✅ ${code} - ${langName}`;
    
    // Tự động ẩn sau 2 giây
    setTimeout(() => {
        notif.style.opacity = '0';
        setTimeout(() => notif.remove(), 300);
    }, 2000);
}

console.log("🔌 YT Dub Uploader đã sẵn sàng!");
