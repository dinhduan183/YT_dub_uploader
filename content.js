// Helper function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Message handler function
function handleMessage(request, _sender, sendResponse) {
    if (request.action === "add_single_lang") {
        addSingleLanguage(request.langCode, request.langName, request.langNameVn, request.audio, request.descAudio, request.rowLabel)
            .then((result) => sendResponse({ success: true, ...(result || {}) }))
            .catch((error) => {
                console.error(error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Keep channel open for async response
    }
    
    // Chạy tất cả / Auto Fix: đọc trạng thái âm thanh trong hộp ngôn ngữ, và xoá 1 dòng âm thanh trong hộp
    if (request.action === "inspect_lang_audio" || request.action === "delete_track_dialog") {
        (request.action === "inspect_lang_audio" ? inspectLanguageAudio(request.langName) : deleteTrackOfLanguage(request.langName, request.kind))
            .then((result) => sendResponse({ success: true, ...(result || {}) }))
            .catch((error) => {
                console.error(error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    if (request.action === "delete_error_audio_auto") {
        deleteErrorAudioAuto(request.langName)
            .then((result) => sendResponse({ success: true, result: result }))
            .catch((error) => {
                console.error(error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    if (request.action === "delete_error_audio" || request.action === "delete_error_audio_quick") {
        (request.action === "delete_error_audio_quick" ? deleteErrorAudioFromTable : deleteErrorAudio)(request.langName)
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

    // Đã nhận đủ các phần → ghép thành File, ghi nhớ để lần sau không phải gửi lại
    if (request.action === "audio_commit") {
        const parts = window.manualDubAudioParts[request.slot] || [];
        window.manualDubAudioParts[request.slot] = [];
        window.manualDubAudioFiles = window.manualDubAudioFiles || {};
        window.manualDubAudioFiles[request.slot] = {
            key: request.key,
            file: new File(parts, request.name, { type: request.type || 'audio/mpeg' })
        };
        sendResponse({ success: true });
        return;
    }

    // Trang đã có sẵn đúng file này chưa
    if (request.action === "audio_has") {
        const saved = (window.manualDubAudioFiles || {})[request.slot];
        sendResponse({ has: !!request.key && !!saved && saved.key === request.key });
        return;
    }

    // Mã của trạm trung chuyển file, null nếu trạm chưa sẵn sàng
    if (request.action === "bridge_token") {
        sendResponse({ token: window.manualDubBridgeReady ? window.manualDubBridgeToken : null });
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

// Báo side panel bước đang làm để hiện dưới ngôn ngữ đang chạy
function reportProgress(text) {
    try {
        chrome.runtime.sendMessage({ action: 'dub_progress', text: text }, () => {
            void chrome.runtime.lastError; // Side panel đã đóng - bỏ qua
        });
    } catch (e) {
        // Extension vừa cập nhật/tải lại - bỏ qua
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

// Trạm trung chuyển file (bridge.html): nhận file gốc từ side panel mà không phải sao chép qua base64.
// content.js được inject lại nhiều lần → chỉ tạo 1 trạm cho mỗi lần tải trang
if (!window.manualDubBridgeToken || !document.getElementById('ytdub-bridge')) {
    const token = crypto.randomUUID();
    window.manualDubBridgeToken = token;
    window.manualDubBridgeReady = false;
    const frame = document.createElement('iframe');
    frame.id = 'ytdub-bridge';
    frame.style.display = 'none';
    frame.src = chrome.runtime.getURL('bridge.html') + '#' + token;
    frame.addEventListener('load', () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = async (e) => {
            const { id, slot, key, file } = e.data || {};
            if (!(file instanceof File)) return;
            channel.port1.postMessage({ ack: id, received: true });
            // Chép nội dung vào bộ nhớ của trang 1 lần: file trên ổ cứng bị đổi giữa chừng
            // (OneDrive đồng bộ, diệt virus quét...) thì YouTube vẫn đọc được, không lỗi NotReadableError
            try {
                const copy = new File([await file.arrayBuffer()], file.name, { type: file.type, lastModified: file.lastModified });
                window.manualDubAudioFiles = window.manualDubAudioFiles || {};
                window.manualDubAudioFiles[slot] = { key: key, file: copy };
                console.log('Đã nhận file trực tiếp:', file.name);
                channel.port1.postMessage({ ack: id, done: true });
            } catch (err) {
                console.error('Không chép được file vào trang:', err);
                channel.port1.postMessage({ ack: id, error: err.message || String(err) });
            }
        };
        frame.contentWindow.postMessage({ type: 'ytdub-port', token: token }, new URL(frame.src).origin, [channel.port2]);
        window.manualDubBridgeReady = true;
    });
    document.documentElement.appendChild(frame);
}

// Trả về { onVideo, mainAdded, descState }
// onVideo: ngôn ngữ đã có trên video từ trước (mở hộp ngôn ngữ từ bảng Bản dịch)
// descState: 'present' (đã có) / 'added' (vừa thêm) / 'blocked' (menu ⋮ không có Add descriptive audio) / 'skipped' (không làm)
//            / 'deleted' (âm thanh mô tả cũ bị lỗi → đã xoá và đóng hộp, side panel thêm lại sau)
async function addSingleLanguage(code, name, nameVn, audio, descAudio, rowLabel) {
    console.log(`Adding language: ${code} - ${nameVn}`);
    window.manualDubAbort = null;

    // BƯỚC 0: Đóng hộp thoại / menu còn mở từ lần chạy dở trước
    reportProgress('Đang mở hộp ngôn ngữ…');
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
    // Chỉ lấy mục của danh sách đang hiện (bỏ mục của menu cũ đã ẩn)
    const langItems = [...document.querySelectorAll('tp-yt-paper-item[test-id]')].filter(isVisible);
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
                await openExistingLanguage(displayName, name, nameVn, rowLabel);
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
        findVisible('#language-details-source-label-audio'), TIMEOUT);
    if (!audioRowShown) {
        throw new Error('Hộp ngôn ngữ không hiện ra');
    }
    await sleep(SETTLE);

    // BƯỚC 3b: Âm thanh mô tả cũ bị lỗi (vd ngôn ngữ đã xoá nhanh âm thanh chính nên không còn trên bảng, nhưng vẫn còn âm thanh mô tả)
    // → xoá rồi đóng hộp; thêm ngay thì hộp vừa xoá có thể chưa hiện nút Add, side panel sẽ quay lại thêm sau
    if (findVisible('#language-details-source-label-descriptive-audio') && isDialogTrackError('descriptive-audio')) {
        reportProgress('Đang xoá âm thanh mô tả lỗi…');
        await deleteTrackInDialog('descriptive-audio');
        await saveLanguageDialog();
        showNotification('Đã xoá âm thanh mô tả lỗi', nameVn);
        return { onVideo, mainAdded: false, descState: 'deleted' };
    }

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
        await uploadAudio('main', audio, 'âm thanh gốc');
        mainAdded = true;
    }

    // BƯỚC 5: Âm thanh mô tả - chỉ thêm được qua menu ⋮ của dòng Audio sau khi đã có âm thanh gốc
    let descState = 'skipped';
    if (findVisible('#language-details-source-label-descriptive-audio')) {
        descState = 'present';
        console.log('Đã có âm thanh mô tả');
    } else if (descAudio) {
        descState = await addDescriptiveAudio(descAudio);
    }

    // BƯỚC 6: Có thay đổi thì bấm Cập nhật, không thì đóng hộp ngôn ngữ
    if (mainAdded || descState === 'added') {
        reportProgress('Chờ nút Cập nhật bật…');
        await clickUpdate();
    } else {
        await closeOpenDialogs();
    }

    // Hiển thị notification
    showNotification(nameVn, code);
    return { onVideo, mainAdded, descState };
}

// Mở hộp ngôn ngữ của 1 ngôn ngữ đã có trên video bằng cách bấm tên ở bảng Bản dịch
async function openExistingLanguage(displayName, name, nameVn, rowLabel) {
    const names = [displayName, name, nameVn, rowLabel].filter(Boolean).map(n => n.trim().toLowerCase());
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

    await openLanguageDialog(langName);
    await deleteTrackInDialog('audio');
    await saveLanguageDialog();

    showNotification(`Đã xoá âm thanh lỗi`, langName);
}

// Tự chọn cách xoá theo trạng thái trong hộp ngôn ngữ:
// - Chính lỗi, mô tả còn tốt → đóng hộp, trả 'quick' để side panel xoá nhanh ở bảng (xoá nhanh chỉ xoá âm thanh chính)
// - Chính lỗi, mô tả lỗi / không có → xoá âm thanh chính trong hộp (mô tả xoá theo) → 'main'
// - Chính còn tốt / không có, mô tả lỗi → xoá âm thanh mô tả trong hộp, giữ âm thanh chính → 'desc'
// - Không có gì lỗi → đóng hộp → 'none'
async function deleteErrorAudioAuto(langName) {
    console.log(`Auto deleting error audio: ${langName}`);
    window.manualDubAbort = null;

    await openLanguageDialog(langName);
    const mainErr = isDialogTrackError('audio');
    const descExists = !!findVisible('#language-details-source-label-descriptive-audio');
    const descErr = descExists && isDialogTrackError('descriptive-audio');

    let result = 'none';
    if (mainErr && descExists && !descErr) {
        result = 'quick';
    } else if (mainErr) {
        await deleteTrackInDialog('audio');
        result = 'main';
    } else if (descErr) {
        await deleteTrackInDialog('descriptive-audio');
        result = 'desc';
    }

    if (result === 'main' || result === 'desc') {
        await saveLanguageDialog();
        showNotification(result === 'main' ? 'Đã xoá âm thanh lỗi' : 'Đã xoá âm thanh mô tả lỗi', langName);
    } else {
        await closeOpenDialogs();
    }
    return result;
}

// Mở hộp ngôn ngữ, đọc trạng thái âm thanh chính / mô tả rồi đóng (không thay đổi gì).
// main / desc: 'error' (lỗi) / 'ok' (còn) / 'none' (không có)
async function inspectLanguageAudio(langName) {
    window.manualDubAbort = null;
    await openLanguageDialog(langName);
    const main = findVisible('#language-details-text-button-audio') ? 'none'
        : isDialogTrackError('audio') ? 'error' : 'ok';
    const desc = !findVisible('#language-details-source-label-descriptive-audio') ? 'none'
        : isDialogTrackError('descriptive-audio') ? 'error' : 'ok';
    await closeOpenDialogs();
    return { main, desc };
}

// Xoá 1 dòng âm thanh trong hộp ngôn ngữ (kind: 'audio' / 'descriptive-audio') rồi Cập nhật
async function deleteTrackOfLanguage(langName, kind) {
    window.manualDubAbort = null;
    await openLanguageDialog(langName);
    await deleteTrackInDialog(kind);
    await saveLanguageDialog();
    showNotification(kind === 'audio' ? 'Đã xoá âm thanh lỗi' : 'Đã xoá âm thanh mô tả lỗi', langName);
}

async function openLanguageDialog(langName) {
    await closeOpenDialogs();
    await openExistingLanguage(langName, langName, langName);

    const audioRowShown = await waitFor(() =>
        findVisible('#language-details-source-label-audio'), TIMEOUT);
    if (!audioRowShown) {
        throw new Error('Hộp ngôn ngữ không hiện ra');
    }
    await sleep(SETTLE);
}

// Dòng âm thanh trong hộp ngôn ngữ đang lỗi không (kind: 'audio' / 'descriptive-audio').
// YouTube hiện icon warning (Không xử lý được) / not_interested (Đã xoá) ở dòng lỗi; dự phòng thêm theo chữ trạng thái.
function isDialogTrackError(kind) {
    const icon = findVisible(`#status-icon-${kind}`);
    if (icon && /warning|error|not_interested/i.test(icon.getAttribute('icon') || '')) return true;
    const label = findVisible(`#language-details-status-label-${kind}`);
    const text = label ? label.textContent.trim().normalize('NFC') : '';
    return /không xử lý|đã xoá|đã xóa|failed|removed/i.test(text);
}

// Menu ⋮ của dòng âm thanh trong hộp ngôn ngữ → Delete → xác nhận, chờ dòng đó biến mất
async function deleteTrackInDialog(kind) {
    const label = kind === 'audio' ? 'Audio' : 'Descriptive audio';
    const btnMore = await waitForElement(() => findVisible(`#language-details-more-options-button-${kind}`));
    if (!btnMore) {
        throw new Error(`Không tìm thấy nút ⋮ ở dòng ${label}`);
    }
    clickButton(btnMore);

    const testId = kind === 'audio' ? 'delete_dubbed_audio' : 'delete_descriptive_audio';
    const menuItem = await waitForElement(() => findVisible(`tp-yt-paper-item[test-id="${testId}"]`), 3000);
    if (!menuItem) {
        await closeMenu(btnMore);
        await closeOpenDialogs();
        throw new Error(`Menu ⋮ của dòng ${label} không có mục Delete`);
    }
    menuItem.click();
    console.log(`Clicked Delete (${label})`);

    // Nếu YouTube hỏi xác nhận xoá thì bấm đồng ý
    const trackGone = kind === 'audio'
        ? () => !findVisible('#language-details-source-label-audio') || !!findVisible('#language-details-text-button-audio')
        : () => !findVisible('#language-details-source-label-descriptive-audio');
    const deleteConfirm = () => [...document.querySelectorAll('ytcp-confirmation-dialog #confirm-button')]
        .find(el => isVisible(el) && !el.closest('#ytgn-save-changes-confirmation-dialog'));
    await waitFor(() => trackGone() || deleteConfirm(), 5000);
    if (deleteConfirm()) {
        clickButton(deleteConfirm());
        console.log('Đã xác nhận xoá');
    }

    const gone = await waitFor(trackGone, TIMEOUT);
    if (!gone) {
        throw new Error(`${label} chưa bị xoá khỏi hộp ngôn ngữ`);
    }
    await sleep(SETTLE);
}

// Có thay đổi chưa lưu thì bấm Cập nhật, không thì đóng hộp ngôn ngữ
async function saveLanguageDialog() {
    const btnUpdate = findVisible('ytcp-button.ytgn-language-dialog-update');
    if (btnUpdate && !btnUpdate.hasAttribute('disabled')) {
        await clickUpdate();
    } else {
        await closeOpenDialogs();
    }
}

// Xoá nhanh âm thanh lỗi ngay ở bảng Bản dịch: rê chuột vào ô Audio → nút ▾ → Delete → Confirm.
// Sau khi xoá, bảng hay vẽ sai các dòng còn lại (dòng dưới bị đẩy lên mang icon lỗi + "–"),
// nên ở đây chỉ bấm xoá; side panel tải lại trang sau mỗi lượt để kiểm tra ngôn ngữ nào còn sót.
async function deleteErrorAudioFromTable(langName) {
    console.log(`Quick deleting error audio: ${langName}`);
    window.manualDubAbort = null;

    await closeOpenDialogs();

    const findRow = () => [...document.querySelectorAll('ytgn-video-translation-row')].find(r => {
        const nameEl = r.querySelector('.language-display-name span');
        return nameEl && nameEl.textContent.trim() === langName;
    });
    const hasError = (row) => !!row && !!row.querySelector('ytgn-video-translation-cell-audio .status-error');

    const row = findRow();
    if (!hasError(row)) {
        throw new Error('Dòng trên bảng không còn ở trạng thái lỗi');
    }

    // Nút ▾ chỉ hiện khi rê chuột vào ô Audio
    const cell = row.querySelector('ytgn-video-translation-cell-audio #cell-container');
    const btnMenu = await waitForElement(() => {
        cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        // Tìm theo class, không theo aria-label: nhãn đổi theo ngôn ngữ giao diện và cách viết hoa của từng bản YouTube
        const el = row.querySelector('ytgn-video-translation-cell-audio ytcp-icon-button.edit-triangle-icon');
        return isVisible(el) ? el : null;
    }, 5000);
    if (!btnMenu) {
        throw new Error('Không thấy nút ▾ ở ô Audio');
    }
    clickButton(btnMenu);

    // YouTube có thể tạo menu mới cho mỗi lần bấm ▾, menu cũ (đã ẩn) vẫn nằm trong trang → lấy mục Delete đang hiện
    const menuItem = await waitForElement(() =>
        [...document.querySelectorAll('ytcp-text-menu tp-yt-paper-item[test-id="delete"]')].find(isVisible) || null, 3000);
    if (!menuItem) {
        await closeMenu(btnMenu);
        throw new Error('Menu ▾ của ô Audio không có mục Delete');
    }
    menuItem.click();

    const confirmBtn = () => [...document.querySelectorAll('ytcp-confirmation-dialog #confirm-button')]
        .find(el => isVisible(el) && !el.closest('#ytgn-save-changes-confirmation-dialog'));
    if (!await waitFor(() => confirmBtn(), 5000)) {
        throw new Error('Không hiện hộp xác nhận Delete track');
    }
    clickButton(confirmBtn());
    console.log('Đã xác nhận xoá');

    // Chờ hộp xác nhận đóng, rồi chờ thêm chút cho bảng cập nhật trước khi xoá dòng tiếp theo
    if (!await waitFor(() => !confirmBtn(), TIMEOUT)) {
        throw new Error('Hộp xác nhận Delete track không đóng');
    }
    await waitFor(() => !hasError(findRow()), 3000);
    await sleep(SETTLE);

    showNotification(`Đã xoá âm thanh lỗi`, langName);
}

// Menu ⋮ của dòng Audio → "Add descriptive audio" → tải file mô tả
async function addDescriptiveAudio(descAudio) {
    const btnMore = await waitForElement(() => findVisible('#language-details-more-options-button-audio'));
    if (!btnMore) {
        throw new Error('Không tìm thấy nút ⋮ ở dòng Audio');
    }
    clickButton(btnMore);

    const menuItem = await waitForElement(() => findVisible('tp-yt-paper-item[test-id="add_descriptive_audio_selection"]'), 3000);
    if (!menuItem) {
        // Menu không có mục này thì bỏ qua
        await closeMenu(btnMore);
        console.log('Menu không có Add descriptive audio');
        return 'blocked';
    }
    menuItem.click();
    console.log('Clicked Add descriptive audio');

    await uploadAudio('desc', descAudio, 'âm thanh mô tả');

    const shown = await waitFor(() =>
        findVisible('#language-details-source-label-descriptive-audio'), TIMEOUT);
    if (!shown) {
        throw new Error('Dòng Descriptive audio không hiện sau khi Xuất bản');
    }
    return 'added';
}

// Thời gian chờ tối đa cho mỗi phần tử, và khoảng nghỉ ngắn sau khi phần tử hiện ra
// (dùng var vì content.js được inject lại mỗi lần bấm - const/let sẽ lỗi khai báo trùng)
var TIMEOUT = 15000;
var SETTLE = 300;
// Thời gian chờ tối đa cho việc tải file âm thanh lên YouTube
var UPLOAD_TIMEOUT = 30 * 60000;

// label: có thì báo side panel kèm số giây đã chờ
async function waitFor(check, timeout, label) {
    const start = Date.now();
    let lastSec = -1;
    while (Date.now() - start < timeout) {
        checkAbort();
        if (check()) return true;
        const sec = Math.floor((Date.now() - start) / 1000);
        if (label && sec !== lastSec) {
            lastSec = sec;
            reportProgress(`${label} ${sec >= 60 ? `${Math.floor(sec / 60)}p${sec % 60}s` : `${sec}s`}`);
        }
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

// YouTube có thể giữ lại menu / hộp thoại cũ đã ẩn trong trang → luôn lấy phần tử đang hiện, không lấy phần tử đầu tiên
function findVisible(selector, root = document) {
    return [...root.querySelectorAll(selector)].find(isVisible) || null;
}

function anyMenuOpen() {
    return [...document.querySelectorAll('tp-yt-paper-item[test-id]')].some(isVisible);
}

function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

// Đóng menu đang mở: bấm Escape, chưa đóng thì bấm lại nút đã mở menu (toggleBtn), rồi bấm ra ngoài
async function closeMenu(toggleBtn) {
    if (!anyMenuOpen()) return;
    pressEscape();
    if (await waitFor(() => !anyMenuOpen(), 1500)) return;
    if (toggleBtn) {
        clickButton(toggleBtn);
        if (await waitFor(() => !anyMenuOpen(), 1500)) return;
    }
    document.body.click();
    await waitFor(() => !anyMenuOpen(), 1500);
}

// Đóng lần lượt từ trong ra ngoài: menu chọn ngôn ngữ → hộp tải âm thanh → hộp ngôn ngữ
async function closeOpenDialogs() {
    const menuOpen = anyMenuOpen;
    if (menuOpen()) {
        await closeMenu(null);
        console.log('Đã đóng menu còn mở');
    }

    const audioCancel = findVisible('ytgn-audio-upload-dialog #cancel-button');
    if (audioCancel) {
        clickButton(audioCancel);
        await waitFor(() => !isVisible(audioCancel), 3000);
        console.log('Đã đóng hộp tải âm thanh còn mở');
    }

    const langCancel = findVisible('ytcp-icon-button.ytgn-language-dialog-cancel');
    const saveConfirm = () => findVisible('ytcp-confirmation-dialog#ytgn-save-changes-confirmation-dialog #confirm-button');
    if (langCancel) {
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

async function uploadAudio(slot, audio, label) {
    reportProgress(`Mở hộp tải ${label}…`);
    // Chờ hộp "Âm thanh bằng..." hiện ra - lấy đúng hộp đang hiện, mọi thao tác sau chỉ làm trong hộp này
    const dialog = await waitForElement(() =>
        [...document.querySelectorAll('ytgn-audio-upload-dialog')].find(d => isVisible(d.querySelector('#upload-button'))) || null);
    if (!dialog) {
        throw new Error('Hộp tải âm thanh không hiện ra');
    }
    await sleep(SETTLE);

    if (!dialog.querySelector('#audio-file-loader')) {
        throw new Error('Không tìm thấy ô chọn file âm thanh');
    }

    // File đã nhận (qua trạm trung chuyển hoặc base64); thiếu/sai file (trang tải lại giữa chừng) thì báo lỗi, không tải file rỗng
    const saved = (window.manualDubAudioFiles || {})[slot];
    const file = saved && saved.key === audio.key ? saved.file : null;
    if (!file || file.size === 0 || (audio.size && file.size !== audio.size)) {
        throw new Error('Dữ liệu file âm thanh bị thiếu, hãy thử lại');
    }

    // Hộp tải có thể còn tên file của lần trước (cùng 1 file dùng cho mọi ngôn ngữ) →
    // theo dõi thay đổi trong hộp, chỉ coi là đã nạp khi hộp có thay đổi sau lúc gán file
    let changed = false;
    const observer = new MutationObserver(() => { changed = true; });
    observer.observe(dialog, { subtree: true, childList: true, characterData: true });

    // Chờ tên file mới hiện trong hộp thoại và nút Xuất bản bật lên rồi mới bấm
    const publishReady = () => {
        const btn = dialog.querySelector('#publish-button');
        return btn && isVisible(btn) && !btn.hasAttribute('disabled') ? btn : null;
    };
    const nameShown = () => {
        const el = dialog.querySelector('.file-name');
        return changed && el && el.textContent.includes(audio.name);
    };
    // Máy chậm: hộp tải có thể chưa sẵn sàng lúc gán nên YouTube bỏ qua file →
    // chưa thấy tên file sau 10 giây thì gán lại (lấy lại ô chọn file vì YouTube có thể đã tạo ô mới)
    const ATTEMPTS = 6;
    let shown = false;
    try {
        for (let attempt = 1; attempt <= ATTEMPTS && !shown; attempt++) {
            const input = dialog.querySelector('#audio-file-loader');
            if (input) {
                const dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                console.log(`Đã gán file (lần ${attempt}):`, audio.name);
            }
            shown = await waitFor(nameShown, 10000, `Chờ YouTube nạp file ${label} (lần ${attempt}/${ATTEMPTS})…`);
        }
    } finally {
        observer.disconnect();
    }
    if (!shown) {
        throw new Error(`Tên file ${audio.name} không hiện trong hộp thoại`);
    }
    await sleep(1500);

    reportProgress('Chờ nút Xuất bản bật…');
    const btnPublish = await waitForElement(publishReady, 10000);
    if (!btnPublish) {
        throw new Error('Nút Xuất bản chưa bấm được');
    }
    checkAbort();
    (btnPublish.querySelector('button') || btnPublish).click();
    console.log('Clicked Xuất bản');

    // Chờ hộp tải đóng lại - file dài trên máy/mạng chậm có thể tải lên mất nhiều phút
    const closed = await waitFor(() => !isVisible(dialog.querySelector('#publish-button')), UPLOAD_TIMEOUT, `Đang tải ${label} lên YouTube…`);
    if (!closed) {
        throw new Error(`Hộp tải âm thanh chưa đóng sau ${UPLOAD_TIMEOUT / 60000} phút`);
    }
    await sleep(SETTLE);
}

async function clickUpdate() {
    // Chờ nút Cập nhật của hộp ngôn ngữ bật lên (sau khi âm thanh "Đã xuất bản") rồi bấm
    const btnUpdate = findVisible('ytcp-button.ytgn-language-dialog-update');
    if (!btnUpdate) {
        throw new Error('Không tìm thấy nút Cập nhật');
    }
    const ready = await waitFor(() => !btnUpdate.hasAttribute('disabled'), UPLOAD_TIMEOUT, 'Chờ nút Cập nhật bật…');
    if (!ready) {
        throw new Error(`Nút Cập nhật chưa bật sau ${UPLOAD_TIMEOUT / 60000} phút`);
    }
    await sleep(1000);
    checkAbort();
    (btnUpdate.querySelector('button') || btnUpdate).click();
    console.log('Clicked Cập nhật');

    const langCancel = findVisible('ytcp-icon-button.ytgn-language-dialog-cancel');
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
