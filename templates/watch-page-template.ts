import type { EventDetailsResponse } from '../worker/src/types';

/**
 * Generates HTML for watch page based on event state
 * States: scheduled (countdown), live (iframe), ended (playlist)
 */
export function generateWatchPageHTML(event: EventDetailsResponse, apiUrl: string): string {
  const isScheduled = event.status === 'scheduled';
  const isLive = event.status === 'live' && event.streamState === 'active';
  const isEnded = event.status === 'ended';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(event.title)} - MomentCast</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #000;
      color: #fff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 2rem;
      text-align: center;
    }
    .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .header p { font-size: 1rem; opacity: 0.9; }
    .container {
      flex: 1;
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
      width: 100%;
    }
    .video-container {
      position: relative;
      padding-bottom: 56.25%; /* 16:9 aspect ratio */
      height: 0;
      background: #111;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 2rem;
    }
    .video-container iframe {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: none;
    }
    .countdown-container {
      text-align: center;
      padding: 4rem 2rem;
      background: #111;
      border-radius: 8px;
    }
    .countdown {
      font-size: 3rem;
      font-weight: bold;
      margin: 2rem 0;
      color: #667eea;
    }
    .live-badge {
      display: inline-block;
      background: #dc2626;
      color: white;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      font-weight: bold;
      animation: pulse 2s infinite;
      margin-bottom: 1rem;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .message {
      text-align: center;
      padding: 2rem;
      background: #1a1a1a;
      border-radius: 8px;
      color: #999;
    }
    .playlist {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-top: 2rem;
    }
    .recording-item {
      background: #1a1a1a;
      padding: 1rem;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .recording-item:hover { background: #2a2a2a; }
    .recording-item.active { background: #667eea; }
    .footer {
      text-align: center;
      padding: 2rem;
      color: #666;
      font-size: 0.875rem;
    }
    @media (max-width: 768px) {
      .header h1 { font-size: 1.5rem; }
      .countdown { font-size: 2rem; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHTML(event.title)}</h1>
    <p>${formatDate(event.scheduledDate)}</p>
  </div>

  <div class="container">
    ${isScheduled ? `
      <div class="countdown-container">
        <h2>Event Starts In</h2>
        <div class="countdown" id="countdown">Loading...</div>
        <p>${formatDate(event.scheduledDate)}</p>
      </div>
    ` : ''}

    ${isLive ? `
      <div class="live-badge">🔴 LIVE</div>
      <div class="video-container">
        ${event.liveInputId ? `
          <iframe
            src="https://customer-${event.liveInputId.substring(0, 10)}.cloudflarestream.com/${event.liveInputId}/iframe"
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen>
          </iframe>
        ` : `<div class="message">Loading live stream...</div>`}
      </div>
    ` : ''}

    ${event.streamState === 'paused' ? `
      <div class="message">
        Stream paused. Checking for resume...
      </div>
    ` : ''}

    ${isEnded ? `
      <h2>Event Replay</h2>
      <div class="video-container" id="player-container"></div>
      ${event.recordings && event.recordings.length > 0 ? `
        <div class="playlist">
          ${event.recordings.map((recording, idx) => `
            <div class="recording-item" onclick="playRecording(${idx})" id="recording-${idx}">
              <strong>${recording.title || `Recording ${idx + 1}`}</strong>
              <span style="float: right; color: #999;">${formatDuration(recording.duration)}</span>
            </div>
          `).join('')}
        </div>
      ` : `
        <div class="message">No recordings available yet.</div>
      `}
    ` : ''}

    ${!isScheduled && !isLive && !isEnded && event.status === 'live' ? `
      <div class="message">
        Stream has paused. Replay will be available in approximately 60 seconds.
      </div>
    ` : ''}
  </div>

  <div class="footer">
    Powered by MomentCast
  </div>

  <script>
    // Countdown timer
    ${isScheduled ? `
      const eventDate = new Date('${event.scheduledDate}').getTime();
      function updateCountdown() {
        const now = new Date().getTime();
        const distance = eventDate - now;
        
        if (distance < 0) {
          location.reload();
          return;
        }
        
        const days = Math.floor(distance / (1000 * 60 * 60 * 24));
        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);
        
        document.getElementById('countdown').textContent = 
          days + 'd ' + hours + 'h ' + minutes + 'm ' + seconds + 's';
      }
      updateCountdown();
      setInterval(updateCountdown, 1000);
      
      // Poll for status change every 10 seconds
      setInterval(() => {
        fetch('${apiUrl}/api/events/${event.slug || 'unknown'}')
          .then(r => r.json())
          .then(data => {
            if (data.status !== 'scheduled') {
              location.reload();
            }
          });
      }, 10000);
    ` : ''}

    // Sequential playlist player
    ${isEnded && event.recordings && event.recordings.length > 0 ? `
      const recordings = ${JSON.stringify(event.recordings)};
      let currentIndex = 0;
      
      function playRecording(index) {
        currentIndex = index;
        const recording = recordings[index];
        const container = document.getElementById('player-container');
        
        // Update active state
        document.querySelectorAll('.recording-item').forEach((el, i) => {
          el.classList.toggle('active', i === index);
        });
        
        // Load video
        container.innerHTML = \`
          <iframe
            src="https://customer-\${recording.uid.substring(0, 10)}.cloudflarestream.com/\${recording.uid}/iframe?autoplay=true"
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
            id="current-player">
          </iframe>
        \`;
        
        // Auto-advance to next recording (approximate)
        setTimeout(() => {
          if (currentIndex < recordings.length - 1) {
            playRecording(currentIndex + 1);
          }
        }, recording.duration * 1000);
      }
      
      // Auto-play first recording
      playRecording(0);
    ` : ''}

    // Poll for stream state changes
    ${isLive || event.streamState === 'paused' ? `
      setInterval(() => {
        fetch('${apiUrl}/api/events/${event.slug || 'unknown'}')
          .then(r => r.json())
          .then(data => {
            if (data.streamState !== '${event.streamState}' || data.status !== '${event.status}') {
              location.reload();
            }
          });
      }, 10000);
    ` : ''}
  </script>
</body>
</html>
  `;
}

/**
 * Utility functions
 */
function escapeHTML(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
