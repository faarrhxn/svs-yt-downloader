import os
import uuid
import asyncio
import glob
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from yt_dlp.networking.impersonate import ImpersonateTarget
import yt_dlp

app = FastAPI(title="SVS Tech Team YouTube Downloader ")

# Mount the static directory to serve HTML, CSS, JS, and logo
app.mount("/static", StaticFiles(directory="static"), name="static")

# In-memory dictionary to track download progress and cancellation flags
# Format: { task_id: { 'status': str, 'percent': str, 'speed': str, 'eta': str, 'size': str, 'cancel': bool, 'filename': str } }
active_downloads = {}

class URLRequest(BaseModel):
    url: str

class DownloadRequest(BaseModel):
    url: str
    format_id: str # Can be a specific video format ID or an audio bitrate string (e.g., 'mp3-320')

class DownloadCancelledException(Exception):
    """Custom exception to abort yt-dlp download"""
    pass

def progress_hook(d):
    """yt-dlp progress hook to update our in-memory status dict"""
    task_id = d['info_dict'].get('task_id')
    if not task_id or task_id not in active_downloads:
        return

    # Check for cancellation
    if active_downloads[task_id].get('cancel', False):
        raise DownloadCancelledException("User cancelled the download.")

    if d['status'] == 'downloading':
        # Grab the raw percent string from yt-dlp
        raw_percent = d.get('_percent_str', '0%')
        
        # FIX: Strip out the terminal color codes (e.g., changing "94m 49.4%" to just "49.4%")
        clean_percent = raw_percent.split('%')[0].split('m')[-1].strip() + '%'
        
        active_downloads[task_id].update({
            'status': 'downloading',
            'percent': clean_percent
        })
        
    elif d['status'] == 'finished':
        active_downloads[task_id]['status'] = 'processing' # Merging via FFmpeg

@app.post("/api/info")
async def get_video_info(req: URLRequest):
    """Extract metadata and available formats for the provided URL"""
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False,
        'http_headers': {
            'Accept-Language': 'en-US,en;q=0.9'
        },
        'extractor_args': {
            'youtube': {
                'lang': ['en', 'en-US']
            }
        },
        
        # --- ANTI-BAN PROTECTIONS ---
        
        # 1. Throttling: Add random delays (seconds) to mimic natural human behavior
        'sleep_interval_requests': 2, 
        'sleep_interval': 3,
        'max_sleep_interval': 8,

        # 2. Browser Impersonation: Spoof Chrome fingerprints
        'impersonate': ImpersonateTarget.from_str('chrome'),
        
        # 3. Proxies (The Ultimate Fix)
        # yt-dlp natively supports HTTP, HTTPS, or SOCKS5 proxies. 
        # If you purchase rotating residential proxies, uncomment the line below:
        # 'proxy': 'http://username:password@your-proxy-host:port',
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.url, download=False)
            video_id = info.get('id')
            # Use a guaranteed direct YouTube thumbnail URL to prevent broken images
            reliable_thumbnail = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

           # Extract basic metadata
            metadata = {
                'id': video_id,
                'title': info.get('title'),
                'thumbnail': reliable_thumbnail,
                'duration': info.get('duration_string', str(info.get('duration', 0))),
                'channel': info.get('uploader'),
                'upload_date': info.get('upload_date'),
                'views': info.get('view_count'),
                'likes': info.get('like_count', 'N/A')
            }

            # Extract and filter video formats
            video_formats = []
            seen_resolutions = set()
            
            # Sort formats by height (resolution) descending
            formats = info.get('formats', [])
            formats.reverse() 

            for f in formats:
                # We want formats with video (vcodec != 'none')
                height = f.get('height')
                if f.get('vcodec') != 'none' and height and height not in seen_resolutions:
                    seen_resolutions.add(height)
                    video_formats.append({
                        'format_id': f"{f['format_id']}+bestaudio", # Merge with best audio
                        'resolution': f"{height}p",
                        'fps': f.get('fps', '30'),
                        'codec': f.get('vcodec'),
                        'hdr': 'hdr' in str(f.get('dynamic_range', '')).lower(),
                        'filesize': f.get('filesize', f.get('filesize_approx', 0)),
                        'ext': 'mp4'
                    })

                     # Sort video formats from highest to lowest resolution
            video_formats = sorted(video_formats, key=lambda x: int(x['resolution'].replace('p','')), reverse=True)

            return JSONResponse({"metadata": metadata, "video_formats": video_formats})

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

def download_task(task_id: str, url: str, format_id: str):
    """Background task to execute the download"""
    output_template = f"downloads/%(title)s_{task_id}.%(ext)s"
    
    ydl_opts = {
        'outtmpl': output_template,
        'progress_hooks': [progress_hook],
        'quiet': True,
        'no_warnings': True,
        
        # --- ANTI-BAN PROTECTIONS ---
        'sleep_interval_requests': 2, 
        'sleep_interval': 3,
        'max_sleep_interval': 8,
        'impersonate': ImpersonateTarget.from_str('chrome'),
        # 'proxy': 'http://username:password@your-proxy-host:port',
    }

    # Configure options based on user selection (MP4 vs MP3)
    if format_id.startswith('mp3'):
        bitrate = format_id.split('-')[1]
        ydl_opts.update({
            'format': 'bestaudio/best',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': bitrate,
            }],
        })
    else:
        ydl_opts.update({
            'format': f"{format_id}/best",
            'merge_output_format': 'mp4'
        })

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Inject task_id into info_dict temporarily so the hook can access it
            ydl.add_default_info_extractors()
            ydl.extract_info(url, download=True, extra_info={'task_id': task_id})
            
        active_downloads[task_id]['status'] = 'completed'
    except DownloadCancelledException:
        active_downloads[task_id]['status'] = 'cancelled'
    except Exception as e:
        active_downloads[task_id]['status'] = 'error'
        active_downloads[task_id]['error'] = str(e)

@app.post("/api/download")
async def start_download(req: DownloadRequest, background_tasks: BackgroundTasks):
    """Initializes the download and returns a tracking ID"""
    task_id = str(uuid.uuid4())
    os.makedirs('downloads', exist_ok=True)
    
    active_downloads[task_id] = {
        'status': 'starting',
        'percent': '0%',
        'speed': '0 KiB/s',
        'eta': 'Calculating...',
        'size': 'Unknown',
        'cancel': False
    }
    
    background_tasks.add_task(download_task, task_id, req.url, req.format_id)
    return JSONResponse({"task_id": task_id})

@app.get("/api/progress/{task_id}")
async def get_progress(task_id: str):
    """Poll endpoint for the frontend to get download progress"""
    if task_id not in active_downloads:
        raise HTTPException(status_code=404, detail="Task not found")
    return JSONResponse(active_downloads[task_id])

@app.post("/api/cancel/{task_id}")
async def cancel_download(task_id: str):
    """Sets the cancellation flag to abort the download"""
    if task_id in active_downloads:
        active_downloads[task_id]['cancel'] = True
        return JSONResponse({"message": "Cancellation requested"})
    raise HTTPException(status_code=404, detail="Task not found")

@app.get("/api/serve/{task_id}")
async def serve_file(task_id: str):
    """Sends the downloaded file from the backend to the user's browser"""
    # Look for the file in the downloads folder
    files = glob.glob(f"downloads/*_{task_id}.*")
    if files:
        filepath = files[0]
        filename = os.path.basename(filepath)
        return FileResponse(path=filepath, filename=filename, media_type='application/octet-stream')
    raise HTTPException(status_code=404, detail="File not found on server")

# Root redirect to the static UI
@app.get("/")
async def root():
return FileResponse("static/index.html")
