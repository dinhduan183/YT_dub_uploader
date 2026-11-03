// Trạm trung chuyển file: iframe ẩn của extension nằm trong tab YouTube Studio.
// Nhận file gốc (đọc thẳng từ ổ cứng, không sao chép) từ side panel qua BroadcastChannel,
// chuyển sang content.js qua MessageChannel riêng. token (trong #) để side panel gửi đúng tab.
const token = location.hash.slice(1);
const channel = new BroadcastChannel('ytdub-bridge');
let port = null;

// content.js gửi cổng MessageChannel sau khi iframe tải xong
window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== 'ytdub-port' || e.data.token !== token) return;
    port = e.ports[0];
    // content.js báo đã nhận / đã chép xong / lỗi → chuyển lại side panel
    port.onmessage = (ev) => channel.postMessage({ ...ev.data, token: token });
});

channel.onmessage = (e) => {
    if (!port || !e.data || e.data.token !== token || !e.data.file) return;
    port.postMessage(e.data);
};
