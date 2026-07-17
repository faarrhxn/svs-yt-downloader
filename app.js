// --- Low GPU Background Stars ---
const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');
let particles = [];

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

class Particle {
    constructor() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.size = Math.random() * 1.5;
        this.speedX = Math.random() * 0.2 - 0.1;
        this.speedY = Math.random() * 0.2 - 0.1;
        this.opacity = Math.random() * 0.5 + 0.1;
    }
    update() {
        this.x += this.speedX;
        this.y += this.speedY;
        if (this.x > canvas.width) this.x = 0;
        if (this.x < 0) this.x = canvas.width;
        if (this.y > canvas.height) this.y = 0;
        if (this.y < 0) this.y = canvas.height;
    }
    draw() {
        ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
    }
}

function initParticles() {
    particles = [];
    for (let i = 0; i < 150; i++) particles.push(new Particle());
}

function animateParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(animateParticles);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
initParticles();
animateParticles();

// --- Application Logic ---
const DOM = {
    input: document.getElementById('url-input'),
    btn: document.getElementById('analyze-btn'),
    btnText: document.querySelector('.btn-text'),
    loader: document.querySelector('.loader'),
    error: document.getElementById('error-msg'),
    metaSection: document.getElementById('metadata-section'),
    formatsSection: document.getElementById('formats-section'),
    progressSection: document.getElementById('progress-section'),
    cancelBtn: document.getElementById('cancel-btn')
};

let currentTaskId = null;
let pollInterval = null;

// Utility functions
const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return 'Unknown Size';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatNumber = (num) => num ? parseInt(num).toLocaleString() : 'N/A';

const showError = (msg) => {
    DOM.error.textContent = msg;
    DOM.error.classList.remove('hidden');
    setTimeout(() => DOM.error.classList.add('hidden'), 5000);
};

const setButtonState = (isLoading) => {
    DOM.btn.disabled = isLoading;
    if (isLoading) {
        DOM.btnText.classList.add('hidden');
        DOM.loader.classList.remove('hidden');
    } else {
        DOM.btnText.classList.remove('hidden');
        DOM.loader.classList.add('hidden');
    }
};

// Step 1: Analyze URL
DOM.btn.addEventListener('click', async () => {
    const url = DOM.input.value.trim();
    
    // Basic YouTube regex validation (handles shorts, music, etc.)
    const ytRegex = /^(https?\:\/\/)?(www\.youtube\.com|youtu\.?be|music\.youtube\.com)\/.+$/;
    if (!ytRegex.test(url)) {
        showError('Please enter a valid YouTube URL.');
        return;
    }

    setButtonState(true);
    DOM.metaSection.classList.add('hidden');
    DOM.formatsSection.classList.add('hidden');
    DOM.progressSection.classList.add('hidden');

    try {
        const response = await fetch('/api/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        
        if (!response.ok) throw new Error('Failed to analyze video. Check URL.');
        const data = await response.json();
        
        renderMetadata(data.metadata);
        renderFormats(data.video_formats, url);
        
    } catch (err) {
        showError(err.message);
    } finally {
        setButtonState(false);
    }
});

// Step 2: Render Metadata
function renderMetadata(meta) {
    document.getElementById('meta-thumb').src = meta.thumbnail;
    document.getElementById('meta-title').textContent = meta.title;
    document.getElementById('meta-channel').textContent = meta.channel;
    document.getElementById('meta-duration').textContent = meta.duration;
    document.getElementById('meta-views').textContent = formatNumber(meta.views) + ' views';
    
    // Format Date (YYYYMMDD to YYYY-MM-DD)
    const dateStr = meta.upload_date;
    const formattedDate = dateStr ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}` : 'Unknown Date';
    document.getElementById('meta-date').textContent = formattedDate;
    document.getElementById('meta-likes').textContent = formatNumber(meta.likes);

    DOM.metaSection.classList.remove('hidden');
}

// Step 3: Render Formats & Handle Downloads
function renderFormats(videos, originalUrl) {
    const mp4List = document.getElementById('mp4-options');
    const mp3List = document.getElementById('mp3-options');
    mp4List.innerHTML = '';
    mp3List.innerHTML = '';

    // Render MP4 Options
    videos.forEach(v => {
        const div = document.createElement('div');
        div.className = 'format-item';
        div.innerHTML = `
            <div class="format-info">
                <span class="f-res">${v.resolution} <span class="badge" style="background:transparent">${v.fps}fps</span></span>
                <span class="f-desc">${v.codec} ${v.hdr ? '• HDR' : ''}</span>
            </div>
            <span class="f-size">${formatBytes(v.filesize)}</span>
        `;
        div.onclick = () => startDownload(originalUrl, v.format_id);
        mp4List.appendChild(div);
    });

    // Render static MP3 Options
    const audioBitrates = [320, 256, 192, 128];
    audioBitrates.forEach(kbps => {
        const div = document.createElement('div');
        div.className = 'format-item';
        div.innerHTML = `
            <div class="format-info">
                <span class="f-res">${kbps} kbps</span>
                <span class="f-desc">MP3 Audio</span>
            </div>
            <span class="f-size">~${Math.round(parseInt(document.getElementById('meta-duration').textContent.split(':').reduce((acc,time) => (60 * acc) + +time)) * kbps / 8 / 1024)} MB</span>
        `;
        div.onclick = () => startDownload(originalUrl, `mp3-${kbps}`);
        mp3List.appendChild(div);
    });

    DOM.formatsSection.classList.remove('hidden');
}

// Step 4: Manage Download Process
async function startDownload(url, format_id) {
    DOM.formatsSection.classList.add('hidden');
    DOM.progressSection.classList.remove('hidden');
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-status').textContent = 'Starting download...';

    try {
        const res = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, format_id })
        });
        const data = await res.json();
        currentTaskId = data.task_id;
        
        pollInterval = setInterval(pollProgress, 1000);
    } catch (err) {
        showError('Failed to start download.');
    }
}

async function pollProgress() {
    if (!currentTaskId) return;

    try {
        const res = await fetch(`/api/progress/${currentTaskId}`);
        const data = await res.json();

        if (data.status === 'downloading') {
            document.getElementById('progress-status').textContent = 'Downloading...';
            document.getElementById('progress-percent').textContent = data.percent;
            document.getElementById('progress-bar').style.width = data.percent;
            
        } else if (data.status === 'processing') {
            document.getElementById('progress-status').textContent = 'Merging Video/Audio...';
            document.getElementById('progress-bar').style.width = '100%';
            
        } else if (data.status === 'completed') {
            clearInterval(pollInterval);
            document.getElementById('progress-status').textContent = 'Download Complete! Saving to PC...';
            document.getElementById('progress-bar').style.background = '#ffffff'; 
            DOM.cancelBtn.classList.add('hidden');
            
            // TRIGGER THE LOCAL BROWSER DOWNLOAD
            window.location.href = `/api/serve/${currentTaskId}`;
            
        } else if (data.status === 'cancelled' || data.status === 'error') {
            clearInterval(pollInterval);
            document.getElementById('progress-status').textContent = data.status === 'error' ? 'Error occurred' : 'Cancelled';
            document.getElementById('progress-bar').style.background = '#ff5555';
            document.getElementById('progress-bar').style.boxShadow = 'none';
        }
    } catch (e) {
        console.error("Polling error", e);
    }
}

// Cancel handler
DOM.cancelBtn.addEventListener('click', async () => {
    if (currentTaskId) {
        await fetch(`/api/cancel/${currentTaskId}`, { method: 'POST' });
    }
});