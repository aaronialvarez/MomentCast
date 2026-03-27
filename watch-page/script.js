// Configuration
const API_URL = 'https://api.momentcast.live';

const slug = window.location.pathname.split('/').filter(Boolean).pop() || '';
// const slug = 'sofia-s-quince';

// State management
let eventData = null;
let countdownInterval = null;
let pollInterval = null;
let currentRecordingIndex = 0;
let playbackMode = null; // 'LIVE', 'LAST_RECORDING', 'SEQUENTIAL', 'WAITING'

// Initialize
async function init() {
  try {
    await fetchEvent();
    updateUI();
    startPolling();
  } catch (error) {
    console.error('Init error:', error);
    showError('Event not found. Please check the URL and try again.');
  }
}

// Fetch event data
async function fetchEvent() {
  try {
    const response = await fetch(`${API_URL}/api/events/${slug}`);
    
    if (!response.ok) {
      throw new Error('Event not found');
    }
    
    eventData = await response.json();
  } catch (error) {
    console.error('Fetch error:', error);
    throw error; // Re-throw so init() can catch it
  }
}

// Start polling based on event state
function startPolling() {
  const isLive = eventData?.status === 'live' || eventData?.stream_state === 'active';
  const isWaitingForResume = playbackMode === 'LAST_RECORDING'; // Poll more frequently when waiting
  
  // Terminal states never change — stop polling entirely
  if (playbackMode === 'EXPIRED' || playbackMode === 'ENDED') {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
    return;
  }

  let pollFrequency;
  if (isLive) {
    pollFrequency = 120000; // 2 minutes when live
  } else if (isWaitingForResume) {
    pollFrequency = 30000; // 30 seconds when waiting for stream to resume
  } else {
    pollFrequency = 60000; // 1 minute for other states
  }
  
  // Only restart if frequency needs to change
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  
  pollInterval = setInterval(async () => {
    const previousState = eventData?.status;
    const previousMode = playbackMode;
    await fetchEvent();
    updateUI();
    
    // Restart polling if state or mode changed (with proper cleanup)
    const newState = eventData?.status;
    const newMode = playbackMode;
    if (previousState !== newState || previousMode !== newMode) {
      clearInterval(pollInterval); // Clear current interval first
      startPolling(); // Then start new one
    }
  }, pollFrequency);
}

// Returns the best available event date string.
// Prefers stream_started_manually_at (actual start) over scheduled_date (planned time).
function getEventDate() {
  const raw = eventData.stream_started_manually_at || eventData.scheduled_date;
  if (!raw) return null;
  return new Date(raw).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

// Injects or updates a date subtitle element directly after the given title element.
// Safe to call on every poll — creates the node once, updates text thereafter.
function setEventDateSubtitle(titleEl, dateString) {
  if (!titleEl || !dateString) return;
  let dateEl = titleEl.parentElement.querySelector('.mc-event-date');
  if (!dateEl) {
    dateEl = document.createElement('p');
    dateEl.className = 'mc-event-date';
    titleEl.insertAdjacentElement('afterend', dateEl);
  }
  dateEl.textContent = dateString;
}

// Renders the photographer's "Presented by" logo inside a player header.
// Looks for .mc-presented-by inside the given header element, creates it if needed.
// Safe to call on every poll — only creates/updates, never duplicates.
function renderLogo(headerEl) {
  if (!headerEl || !eventData?.logo_url) {
    // No logo — remove container if it was previously shown
    const existing = headerEl?.querySelector('.mc-presented-by');
    if (existing) existing.remove();
    return;
  }

  let container = headerEl.querySelector('.mc-presented-by');
  if (!container) {
    container = document.createElement('div');
    container.className = 'mc-presented-by';
    container.innerHTML = `
      <span class="mc-presented-label">Presented by</span>
      <img class="mc-presented-logo" src="" alt="Photographer logo" />
    `;
    headerEl.appendChild(container);
  }

  // Update src if it changed (e.g. photographer replaced logo mid-event)
  const img = container.querySelector('.mc-presented-logo');
  if (img && img.src !== eventData.logo_url) {
    img.src = eventData.logo_url;
  }
}

/**
 * Show or hide the QR share block in the countdown section.
 * Visible only in COUNTDOWN and WAITING modes (before the event goes live).
 * QR data URL comes pre-generated from the API — no client-side work needed.
 */
function renderQrBlock(visible) {
  const block = document.getElementById('qr-share-block');
  if (!block) return;

  if (!visible || !eventData?.qr_code_data_url) {
    block.classList.add('hidden');
    return;
  }

  const img = document.getElementById('qr-image');
  const urlEl = document.getElementById('qr-url');

  if (img && img.src !== eventData.qr_code_data_url) {
    img.src = eventData.qr_code_data_url;
  }
  if (urlEl) {
    urlEl.textContent = `go.momentcast.live/${slug}`;
  }

  block.classList.remove('hidden');
}

// Determine playback mode based on event state and 2-hour timeout
function determinePlaybackMode() {
  if (!eventData) return 'WAITING';
  
  const now = new Date();
  const scheduledDate = new Date(eventData.scheduled_date);
  const isLive = eventData.status === 'live' && eventData.stream_state === 'active';
  const isEnded = eventData.status === 'ended';
  const hasRecordings = eventData.recordings && eventData.recordings.length > 0;
  
  // Check 2-hour timeout if we have last_stream_activity
  let timeSinceActivity = null;
  let recentActivity = false;
  if (eventData.last_stream_activity) {
    const lastActivity = new Date(eventData.last_stream_activity);
    timeSinceActivity = now - lastActivity;
    const twoHours = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    recentActivity = timeSinceActivity < twoHours;
  }
  
  // Decision tree
  if (isLive) {
    return 'LIVE';
  }
  
  if (isEnded) {
    // Check if event ended more than 30 days ago
    const endedAt = eventData.stream_started_manually_at 
      ? new Date(eventData.stream_started_manually_at) 
      : scheduledDate;
    const daysSinceEvent = (now - endedAt) / (1000 * 60 * 60 * 24);
    
    if (daysSinceEvent > 30) {
      return 'EXPIRED';
    }
    
    return hasRecordings ? 'SEQUENTIAL' : 'ENDED';
  }
  
  // Event is 'ready' (within 24h window)
  if (eventData.status === 'ready') {
    // If stream just disconnected (< 10 minutes) and no recordings yet, show processing
    if (!hasRecordings && recentActivity && timeSinceActivity < 10 * 60 * 1000) {
      return 'PROCESSING'; // New mode for recording finalization
    }
    
    if (!hasRecordings) {
      return 'WAITING'; // No recordings yet, show waiting
    }
    
    if (recentActivity) {
      // Count ready recordings
      const readyRecordings = eventData.recordings.filter(r => {
        return r.readyToStream === true || r.status === 'ready' || r.state?.state === 'ready';
      });
      
      // If multiple finalized recordings exist, play them all sequentially
      if (readyRecordings.length > 1) {
        return 'SEQUENTIAL';
      }
      
      // Single recording: play it and wait for stream to resume
      return 'LAST_RECORDING';
    } else {
      return 'SEQUENTIAL'; // > 2hrs, play all recordings sequentially
    }
  }
  
  // Scheduled state
  if (now < scheduledDate) {
    return 'COUNTDOWN';
  }
  
  // Fallback
  return 'WAITING';
}

// Update status badge based on event state
function updateStatusBadge() {
  const badge = document.getElementById('event-status-badge'); // or whatever the ID is
  if (!badge) return;
  
  if (eventData.status === 'live' && eventData.stream_state === 'active') {
    badge.textContent = 'LIVE';
    badge.className = 'badge live'; // red badge
  } else if (eventData.status === 'ready' && eventData.stream_state === 'disconnected') {
    badge.textContent = 'PAUSED';
    badge.className = 'badge paused'; // yellow badge
  } else if (eventData.status === 'ended') {
    badge.textContent = 'ENDED';
    badge.className = 'badge ended'; // gray badge
  } else {
    badge.textContent = 'SCHEDULED';
    badge.className = 'badge scheduled';
  }
}

// Update UI based on event state
function updateUI() {
  updateStatusBadge();
  if (!eventData) {
    showError();
    return;
  }

  // Check if viewer limit exceeded
  const hasRecordings = eventData.recordings && eventData.recordings.length > 0;
  const isLive = eventData.status === 'live' && eventData.stream_state === 'active';
  if ((isLive || hasRecordings) && eventData.limitExceeded) {
    const limitEl = document.getElementById('limit-exceeded');
    if (!limitEl || limitEl.classList.contains('hidden')) {
      document.querySelectorAll('.state').forEach(el => el.classList.add('hidden'));
      showLimitExceeded();
    }
    return;
  }

  // Determine what mode we should be in
  const newMode = determinePlaybackMode();
    console.log('Mode:', newMode, '| days since event:', 
    (new Date() - new Date(eventData.stream_started_manually_at)) / (1000 * 60 * 60 * 24),
    '| hasRecordings:', eventData.recordings?.length,
    '| status:', eventData.status
  );
  // Always render on first load (playbackMode is null), then only on state changes
  if (newMode !== playbackMode || playbackMode === null) {
    console.log(`Playback mode changed v4: ${playbackMode} -> ${newMode}`);
    
    // Clear any auto-advance mechanisms when switching modes
    if (currentStreamPlayer) {
      window.removeEventListener('message', currentStreamPlayer);
      currentStreamPlayer = null;
    }
    if (advanceCheckInterval) {
      clearInterval(advanceCheckInterval);
      clearTimeout(advanceCheckInterval); // In case it's a timeout instead of interval
      advanceCheckInterval = null;
    }
    
    playbackMode = newMode;
    document.querySelectorAll('.state').forEach(el => el.classList.add('hidden'));
    
    // Update status badge
    updateStatusBadge();
    
    switch (newMode) {
      case 'LIVE':
        showLive();
        break;
      case 'PROCESSING':
        showProcessing();
        break;
      case 'LAST_RECORDING':
        showLastRecording();
        break;
      case 'SEQUENTIAL':
        showSequentialPlayback();
        break;
      case 'COUNTDOWN':
        showCountdown();
        break;
      case 'ENDED':
        showCountdownState('ENDED');
        break;
      case 'EXPIRED':
        showCountdownState('EXPIRED');
        break;
      case 'WAITING':
      default:
        showCountdownState('WAITING');
        break;
    }
  }
}

// Show countdown state
function showCountdown() {
  const countdownEl = document.getElementById('countdown');
  const titleEl = document.getElementById('event-title');
  const scheduledTimeEl = document.getElementById('scheduled-time');

  titleEl.textContent = eventData.title;
  
  const scheduledDate = new Date(eventData.scheduled_date);
  scheduledTimeEl.textContent = scheduledDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });

  // Clear existing interval
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }

  // Update countdown every second
  countdownInterval = setInterval(() => {
    updateCountdown(scheduledDate);
  }, 1000);

  updateCountdown(scheduledDate);
  renderQrBlock(true); // Show QR code during countdown
  applyCoverBackground(countdownEl); // Full-bleed cover photo behind countdown
  countdownEl.classList.remove('hidden');
}

// Update countdown timer
function updateCountdown(targetDate) {
  const now = new Date();
  const diff = targetDate - now;
  
  if (diff <= 0) {
    // Stop the countdown
    clearInterval(countdownInterval);
    countdownInterval = null;
    
    // Hide the countdown numbers (days/hours/minutes/seconds)
    const daysEl = document.getElementById('days');
    const hoursEl = document.getElementById('hours');
    const minutesEl = document.getElementById('minutes');
    const secondsEl = document.getElementById('seconds');
    
    if (daysEl && hoursEl && minutesEl && secondsEl) {
      daysEl.parentElement.style.display = 'none';
    }
    
    // Show "starting soon" message
    let messageEl = document.getElementById('starting-message');
    if (!messageEl) {
      messageEl = document.createElement('p');
      messageEl.id = 'starting-message';
      messageEl.className = 'mc-starting-message'; // "Event starting soon..." text
      messageEl.textContent = 'Event starting soon...';
      document.getElementById('countdown').appendChild(messageEl);
    }
    
    // Check status once after 5 seconds
    setTimeout(() => {
      fetchEvent().then(() => updateUI());
    }, 5000);
    return;
  }
  
  // Normal countdown display
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  
  document.getElementById('days').textContent = String(days).padStart(2, '0');
  document.getElementById('hours').textContent = String(hours).padStart(2, '0');
  document.getElementById('minutes').textContent = String(minutes).padStart(2, '0');
  document.getElementById('seconds').textContent = String(seconds).padStart(2, '0');
}

// Show live stream state
function showLive() {
  const liveEl = document.getElementById('live');
  const titleEl = document.getElementById('live-title');
  let streamEl = document.getElementById('live-stream');
  
  // Remove processing message if it exists
  const processingMessage = liveEl.querySelector('.processing-message');
  if (processingMessage) {
    processingMessage.remove();
  }
  
  titleEl.textContent = eventData.title;
  setEventDateSubtitle(titleEl, getEventDate()); // Show event date below title
  renderLogo(liveEl.querySelector('.mc-player-header')); // Show photographer logo
  
  // If iframe was destroyed (by showProcessing), recreate it
  if (!streamEl) {
    const container = liveEl.querySelector('.relative');
    if (container) {
      container.innerHTML = `
        <iframe
          id="live-stream"
          style="border: none; position: absolute; top: 0; height: 100%; width: 100%"
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
          allowfullscreen="true"
        ></iframe>
      `;
      streamEl = document.getElementById('live-stream');
    }
  }
  
  const liveInputId = eventData.live_input_id || eventData.liveinputid;
  
  if (liveInputId && streamEl) {
    // Start muted to guarantee autoplay (browsers block unmuted autoplay without user gesture)
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${liveInputId}/iframe?autoplay=true&muted=true`;
    
    // Only set src when switching to live mode (not on every poll)
    if (streamEl.src !== embedUrl) {
      console.log('Setting iframe src to:', embedUrl);
      streamEl.src = embedUrl;
      
      // Show tap-to-unmute overlay once iframe loads
      attachMuteOverlay(streamEl);
    }
  } else if (!liveInputId) {
    console.error('No live_input_id found in eventData:', eventData);
  }

  // Check if stream is disconnected but recording is finalizing
  if (eventData.stream_state === 'disconnected' && eventData.status === 'live') {
    // Add processing overlay
    let processingOverlay = document.getElementById('processing-overlay');
    if (!processingOverlay) {
      processingOverlay = document.createElement('div');
      processingOverlay.id = 'processing-overlay';
      processingOverlay.className = 'mc-processing-overlay'; // Dark overlay shown while recording finalizes
      processingOverlay.innerHTML = `
        <div class="mc-processing-inner">
          <div class="mc-spinner"></div>
          <p class="mc-processing-title">Processing recording...</p>
          <p class="mc-processing-sub">This usually takes 5 minutes</p>
        </div>
      `;
      
      const liveContainer = streamEl.parentElement;
      if (liveContainer) {
        liveContainer.style.position = 'relative';
        liveContainer.appendChild(processingOverlay);
      }
    }
  } else {
    // Remove processing overlay if it exists
    const processingOverlay = document.getElementById('processing-overlay');
    if (processingOverlay) {
      processingOverlay.remove();
    }
  }
  
  liveEl.classList.remove('hidden');
}

// Unmute hint — a non-blocking toast that draws attention to the player's
// built-in mute button. Browsers require the user gesture to originate INSIDE
// the iframe for audio to unlock, so no parent-page overlay can programmatically
// unmute a cross-origin iframe. This is the same pattern YouTube/X/Instagram use.
function showUnmuteHint(iframeEl) {
  const existing = document.getElementById('unmute-hint');
  if (existing) existing.remove();

  const container = iframeEl?.parentElement;
  if (!container) return;

  const hint = document.createElement('div');
  hint.id = 'unmute-hint';
  hint.className = 'mc-unmute-hint';
  hint.innerHTML = `
    <span>Tap</span>
    <svg class="mc-unmute-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <line x1="23" y1="9" x2="17" y2="15"></line>
      <line x1="17" y1="9" x2="23" y2="15"></line>
    </svg>
    <span>to unmute</span>
  `;

  container.appendChild(hint);

  // Auto-dismiss after 5 seconds
  const timer = setTimeout(() => hint.remove(), 5000);

  // Also dismiss on any click inside the container (user is interacting with player)
  container.addEventListener('click', function dismiss() {
    clearTimeout(timer);
    container.removeEventListener('click', dismiss);
    hint.remove();
  }, { once: true });
}

// Attaches a one-time load listener to show the unmute hint once the iframe is ready.
function attachMuteOverlay(iframeEl) {
  iframeEl.addEventListener('load', function onLoad() {
    iframeEl.removeEventListener('load', onLoad);
    showUnmuteHint(iframeEl);
  });
}

// Show processing state when recording is finalizing
function showProcessing() {
  const liveEl = document.getElementById('live');
  const titleEl = document.getElementById('live-title');
  
  titleEl.textContent = eventData.title;
  
  // Show a processing message without destroying the iframe structure
  const streamEl = document.getElementById('live-stream');
  let processingMessage = liveEl.querySelector('.processing-message');
  if (!processingMessage) {
    processingMessage = document.createElement('div');
    processingMessage.className = 'processing-message mc-processing-overlay mc-processing-overlay--dark'; // Full-area overlay inside live container
    processingMessage.innerHTML = `
      <div class="mc-processing-inner">
        <div class="mc-spinner mc-spinner--gold"></div>
        <p class="mc-processing-title">Processing recording...</p>
        <p class="mc-processing-sub">Your stream will be ready for playback shortly</p>
        <p class="mc-processing-sub mc-processing-sub--faint">Usually takes 1-2 minutes</p>
      </div>
    `;
    const container = streamEl?.parentElement;
    if (container) {
      container.style.position = 'relative';
      container.appendChild(processingMessage);
    }
  }
  
  liveEl.classList.remove('hidden');
}

// Show last/most recent recording (< 2 hours since activity)
function showLastRecording() {
  const replayEl = document.getElementById('replay');
  const titleEl = document.getElementById('replay-title');
  const streamEl = document.getElementById('replay-stream');

  titleEl.textContent = eventData.title;
  setEventDateSubtitle(titleEl, getEventDate()); // Show event date below title
  renderLogo(replayEl.querySelector('.mc-player-header')); // Show photographer logo

  console.log('Playing last recording (< 2hr timeout):', eventData.recordings);

  // Sort recordings by created timestamp (newest first) and filter for ready ones
  const recordings = [...eventData.recordings]
    .filter(recording => {
      return recording.readyToStream === true || recording.status === 'ready' || recording.state?.state === 'ready';
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
  
  // Use most recent READY recording (skip any still processing)
  const videoId = recordings[0]?.uid;

  // If no ready recordings available, show processing state
  if (!videoId && eventData.recordings.length > 0) {
    console.log('No ready recordings yet, showing processing state');
    showProcessing();
    return;
  }
  
  if (videoId) {
    // Start muted to guarantee autoplay; overlay prompts user to unmute
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${videoId}/iframe?autoplay=true&muted=true`;
    
    // Only set src if it's different (prevents reload on poll)
    if (streamEl.src !== embedUrl) {
      console.log('Setting last recording iframe src to:', embedUrl);
      streamEl.src = embedUrl;
      attachMuteOverlay(streamEl);
    }
  } else {
    console.error('No recordings found in eventData:', eventData);
  }

  // Remove live banner if it exists
  const liveBanner = document.getElementById('live-banner');
  if (liveBanner) {
    liveBanner.remove();
  }
  
  // Add/update waiting message banner below the player
  let waitingBanner = document.getElementById('waiting-banner');
  if (!waitingBanner) {
    waitingBanner = document.createElement('div');
    waitingBanner.id = 'waiting-banner';
    waitingBanner.className = 'mc-waiting-banner';
    // Insert inside .mc-player-wrap, before the footer
    const playerWrap = replayEl.querySelector('.mc-player-wrap');
    const footer = replayEl.querySelector('.mc-player-footer');
    if (footer) {
      playerWrap.insertBefore(waitingBanner, footer);
    } else {
      playerWrap.appendChild(waitingBanner);
    }
  }

  // Recalculate every poll so "X min ago" stays current
  let timeSinceText = '';
  if (eventData.last_stream_activity) {
    const lastActivity = new Date(eventData.last_stream_activity);
    const minutesAgo = Math.floor((Date.now() - lastActivity) / (1000 * 60));
    timeSinceText = minutesAgo > 0 ? ` (${minutesAgo} min ago)` : '';
  }

  waitingBanner.innerHTML = `
    <span class="mc-waiting-dot"></span>
    <span>Stream paused${timeSinceText} — Check back soon for more coverage...</span>
  `;

  replayEl.classList.remove('hidden');
}

// Show sequential playback (> 2 hours since activity or event ended)
function showSequentialPlayback() {
  const replayEl = document.getElementById('replay');
  const titleEl = document.getElementById('replay-title');
  const streamEl = document.getElementById('replay-stream');

  titleEl.textContent = eventData.title;
  setEventDateSubtitle(titleEl, getEventDate()); // Show event date below title
  renderLogo(replayEl.querySelector('.mc-player-header')); // Show photographer logo

  console.log('Playing sequential recordings:', eventData.recordings);

  // Sort recordings by created timestamp (oldest first) and filter for ready ones
  // Handle different property formats: readyToStream, status, or state.state
  const allRecordings = [...eventData.recordings]
    .filter(recording => {
      // Check multiple possible "ready" indicators
      if (recording.readyToStream === true) return true;
      if (recording.status === 'ready') return true;
      if (recording.state?.state === 'ready') return true;
      return false;
    })
    .sort((a, b) => new Date(a.created) - new Date(b.created));
  
  console.log(`Found ${allRecordings.length} ready recordings out of ${eventData.recordings.length} total`);
  
  // If no ready recordings available yet, show processing state
  if (allRecordings.length === 0) {
    console.log('No ready recordings yet, showing processing state');
    showProcessing();
    return;
  }
  
  // Reset index if it's beyond available recordings
  if (currentRecordingIndex >= allRecordings.length) {
    currentRecordingIndex = 0;
  }
  
  const videoId = allRecordings[currentRecordingIndex]?.uid;
  
  if (videoId) {
    // Start muted to guarantee autoplay; overlay prompts user to unmute on first video
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${videoId}/iframe?autoplay=true&muted=true`;
    
    // Only set src if it's different (prevents reload on poll)
    if (streamEl.src !== embedUrl) {
      console.log(`Setting sequential playback iframe src (${currentRecordingIndex + 1}/${allRecordings.length}):`, embedUrl);
      streamEl.src = embedUrl;
      
      // Only show overlay on the first video (user already interacted for subsequent ones)
      if (currentRecordingIndex === 0) {
        attachMuteOverlay(streamEl);
      }
      
      // Set up event listener for when this recording ends
      setupSequentialAdvance(streamEl, allRecordings);
    }
  } else {
    console.error('No recordings found in eventData:', eventData);
  }

  // Remove waiting banner if it exists
  const waitingBanner = document.getElementById('waiting-banner');
  if (waitingBanner) {
    waitingBanner.remove();
  }
  
  // Remove live banner if it exists
  const liveBanner = document.getElementById('live-banner');
  if (liveBanner) {
    liveBanner.remove();
  }
  
  // Add progress banner
  let progressBanner = document.getElementById('progress-banner');
  if (!progressBanner) {
    progressBanner = document.createElement('div');
    progressBanner.id = 'progress-banner';
    progressBanner.className = 'mc-progress-banner'; // Sequential video counter shown during replay
    
    // Insert banner after the title element
    const titleEl = document.getElementById('replay-title');
    if (titleEl && titleEl.parentNode) {
      titleEl.parentNode.insertBefore(progressBanner, titleEl.nextSibling);
    }
  }
  
  // Update progress text
  const statusText = eventData.status === 'ended' ? 'Event Replay' : 'Event In Progress';
  progressBanner.innerHTML = `
    <span>${statusText} - Video <span id="current-video-num">${currentRecordingIndex + 1}</span> of ${allRecordings.length}</span>
    <span class="text-gray-400 ml-2">Auto-advancing</span>
  `;

  replayEl.classList.remove('hidden');
}

// Setup auto-advance for sequential playback
// Tracks actual video playback position via postMessage timeupdate events
let currentStreamPlayer = null;
let advanceCheckInterval = null;
let lastKnownTime = 0;
let lastUpdateTimestamp = 0;

function setupSequentialAdvance(iframeElement, recordings) {
  // Clear any previous instances
  if (currentStreamPlayer) {
    window.removeEventListener('message', currentStreamPlayer);
    currentStreamPlayer = null;
  }
  if (advanceCheckInterval) {
    clearInterval(advanceCheckInterval);
    advanceCheckInterval = null;
  }
  
  const currentRecording = recordings[currentRecordingIndex];
  if (!currentRecording) {
    console.warn('No current recording found');
    return;
  }
  
  // Reset tracking variables
  lastKnownTime = 0;
  lastUpdateTimestamp = Date.now();
  let hasAdvanced = false;
  
  // Listen for postMessage from Stream Player
  const messageHandler = (event) => {
    // Only process messages from Cloudflare Stream
    if (!event.origin.includes('cloudflarestream.com')) return;
    
    try {
      const data = event.data;
      
      // Cloudflare Stream uses __privateUnstableMessageType format
      if (data && data.__privateUnstableMessageType === 'propertyChange') {
        
        // Track currentTime updates
        if (data.property === 'currentTime' && typeof data.value === 'number') {
          lastKnownTime = data.value;
          lastUpdateTimestamp = Date.now();
          
          // Optional: Log when approaching end
          if (currentRecording.duration && currentRecording.duration - lastKnownTime < 3) {
            console.log(`Video ${currentRecordingIndex + 1} at ${lastKnownTime.toFixed(1)}/${currentRecording.duration}s`);
          }
        }
        
        // Check for ended event
        if (data.property === 'ended' && data.value === true) {
          if (!hasAdvanced) {
            console.log(`Video ${currentRecordingIndex + 1} ended (via ended event), advancing...`);
            hasAdvanced = true;
            window.removeEventListener('message', messageHandler);
            if (advanceCheckInterval) clearInterval(advanceCheckInterval);
            advanceToNextRecording(recordings);
          }
          return;
        }
      }
    } catch (e) {
      // Ignore parsing errors
      console.error('Error processing Stream message:', e);
    }
  };
  
  currentStreamPlayer = messageHandler;
  window.addEventListener('message', messageHandler);
  
  console.log(`Video ${currentRecordingIndex + 1} duration: ${currentRecording.duration}s (tracking via timeupdate)`);
  
  // Polling mechanism that uses lastKnownTime instead of wall-clock time
  advanceCheckInterval = setInterval(() => {
    if (hasAdvanced) {
      clearInterval(advanceCheckInterval);
      return;
    }
    
    // If we have duration and current time info
    if (currentRecording.duration && lastKnownTime > 0) {
      const remainingTime = currentRecording.duration - lastKnownTime;
      
      // Advance when video position is within 1 second of end
      if (remainingTime <= 1) {
        console.log(`Video ${currentRecordingIndex + 1} ended (position: ${lastKnownTime.toFixed(1)}/${currentRecording.duration}s), advancing...`);
        hasAdvanced = true;
        clearInterval(advanceCheckInterval);
        advanceCheckInterval = null;
        window.removeEventListener('message', messageHandler);
        advanceToNextRecording(recordings);
        return;
      }
      
      // Check if video seems stuck (no timeupdate for 10 seconds)
      const timeSinceLastUpdate = (Date.now() - lastUpdateTimestamp) / 1000;
      if (timeSinceLastUpdate > 10 && lastKnownTime > 0) {
        // console.warn(`No timeupdate for ${timeSinceLastUpdate.toFixed(0)}s, video may be paused or ended`);
        
        // If we're near the end and haven't received updates, assume it ended
        if (remainingTime < 5) {
          console.log(`Video ${currentRecordingIndex + 1} appears ended (stuck near end), advancing...`);
          hasAdvanced = true;
          clearInterval(advanceCheckInterval);
          window.removeEventListener('message', messageHandler);
          advanceToNextRecording(recordings);
        }
      }
    } else if (!currentRecording.duration) {
      // No duration available - fallback to simple timeout
      const elapsed = (Date.now() - lastUpdateTimestamp) / 1000;
      if (elapsed > 120) { // 2 minute timeout
        console.log('Video timeout (no duration), advancing...');
        hasAdvanced = true;
        clearInterval(advanceCheckInterval);
        window.removeEventListener('message', messageHandler);
        advanceToNextRecording(recordings);
      }
    }
  }, 1000); // Check every 1 second for better responsiveness
}

// Advance to next recording in sequential playback
function advanceToNextRecording(recordings) {
  currentRecordingIndex++;
  
  if (currentRecordingIndex >= recordings.length) {
    console.log('All recordings finished');
    
    // Update progress banner to show completion
    const progressBanner = document.getElementById('progress-banner');
    if (progressBanner) {
      const statusText = eventData.status === 'ended' ? 'Event Replay' : 'Event Recording';
      progressBanner.innerHTML = `
        <span>${statusText} - All ${recordings.length} videos complete</span>
        <span class="text-gray-400 ml-2">Refresh to replay</span>
      `;
    }
    
    return;
  }
  
  // Update the progress counter
  const currentVideoNum = document.getElementById('current-video-num');
  if (currentVideoNum) {
    currentVideoNum.textContent = currentRecordingIndex + 1;
  }
  
  // Load next recording
  const videoId = recordings[currentRecordingIndex]?.uid;
  if (videoId) {
    const streamEl = document.getElementById('replay-stream');
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${videoId}/iframe?autoplay=true&muted=false`;
    console.log(`Loading recording ${currentRecordingIndex + 1}/${recordings.length}`);
    streamEl.src = embedUrl;
    
    // CRITICAL: Set up auto-advance listener for the new video
    setupSequentialAdvance(streamEl, recordings);
  }
}

// Show completion message when all recordings are done
function showAllRecordingsComplete() {
  const replayEl = document.getElementById('replay');
  const streamEl = document.getElementById('replay-stream');
  
  // Create completion overlay
  let completionOverlay = document.getElementById('completion-overlay');
  if (!completionOverlay) {
    completionOverlay = document.createElement('div');
    completionOverlay.id = 'completion-overlay';
    completionOverlay.className = 'mc-completion-overlay'; // Shown when all sequential recordings finish
    completionOverlay.innerHTML = `
      <div class="mc-completion-inner">
        <p class="mc-completion-title">All recordings complete</p>
        <p class="mc-completion-sub">Thank you for watching!</p>
        <button onclick="location.reload()" class="mc-completion-btn">
          Replay from beginning
        </button>
      </div>
    `;
    
    // Find the iframe container and add overlay
    const container = streamEl.parentElement;
    container.style.position = 'relative';
    container.appendChild(completionOverlay);
  }
}

// Show replay state
function showReplay() {
  const replayEl = document.getElementById('replay');
  const titleEl = document.getElementById('replay-title');
  const streamEl = document.getElementById('replay-stream');

  titleEl.textContent = eventData.title;
  setEventDateSubtitle(titleEl, getEventDate()); // Show event date below title
  renderLogo(replayEl.querySelector('.mc-player-header')); // Show photographer logo

  console.log('Replay data:', eventData.recordings);

  // Use oldest recording (last in array, since API returns newest first)
  const videoId = eventData.merged_video_id || (eventData.recordings[eventData.recordings.length - 1]?.uid);
  
  if (videoId) {
    // Start muted to guarantee autoplay; overlay prompts user to unmute
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${videoId}/iframe?autoplay=true&muted=true`;
    
    // Only set src if it's different (prevents reload on poll)
    if (streamEl.src !== embedUrl) {
      console.log('Setting replay iframe src to:', embedUrl);
      streamEl.src = embedUrl;
      attachMuteOverlay(streamEl);
    }
  } else {
    console.error('No recordings found in eventData:', eventData);
  }

  // Remove live banner if it exists
  const liveBanner = document.getElementById('live-banner');
  if (liveBanner) {
    liveBanner.remove();
  }

  replayEl.classList.remove('hidden');
}

// Consolidated handler for all non-live, non-replay countdown states
// Modes: 'WAITING' | 'ENDED' | 'EXPIRED'
function showCountdownState(mode) {
  const countdownEl = document.getElementById('countdown');
  const titleEl = document.getElementById('event-title');

  // Stop any running countdown
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  titleEl.textContent = eventData.title;

  const scheduledDate = new Date(eventData.scheduled_date);
  const heldOn = scheduledDate.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });

  // Message config per mode
  const config = {
    WAITING: {
      date: `Scheduled for ${heldOn}`,
      title: 'Event starting soon\u2026',
      subtitle: ''
    },
    ENDED: {
      date: `Held on ${heldOn}`,
      title: 'This event has ended',
      subtitle: 'No recording is available'
    },
    EXPIRED: {
      date: `Held on ${heldOn}`,
      title: 'Recording No Longer Available',
      subtitle: 'Recordings are kept for 30 days after the event.'
    }
  };

  const { date, title, subtitle } = config[mode] || config.WAITING;

  // Replace the entire timer block — no more timer grid or "Event starts in" heading
  const timerBlock = countdownEl.querySelector('.countdown-timer');
  if (timerBlock) {
    timerBlock.innerHTML = `
      <p class="scheduled-time">${date}</p>
      <div class="status-message">
        <p class="status-message-title">${title}</p>
        ${subtitle ? `<p class="status-message-subtitle">${subtitle}</p>` : ''}
      </div>
    `;
  }

  // QR code only shown in WAITING state (before event goes live)
  renderQrBlock(mode === 'WAITING');

  // Cover photo only shown in WAITING and COUNTDOWN states
  if (mode === 'WAITING') {
    applyCoverBackground(countdownEl);
  } else {
    removeCoverBackground(countdownEl);
  }

  countdownEl.classList.remove('hidden');
}

// Show limit exceeded state
function showLimitExceeded() {
  // Hide all other states
  document.querySelectorAll('.state').forEach(el => el.classList.add('hidden'));
  
  // Create or show limit exceeded element
  let limitEl = document.getElementById('limit-exceeded');
  if (!limitEl) {
    limitEl = document.createElement('div');
    limitEl.id = 'limit-exceeded';
    limitEl.className = 'state mc-limit-screen'; // Full-screen viewer limit message
    limitEl.innerHTML = `
      <div class="mc-limit-inner">
        <div class="mc-limit-icon">
          <svg width="48" height="48" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
        </div>
        <h2 class="mc-limit-title">Viewing Limit Reached</h2>
        <p class="mc-limit-body">This event has reached its viewing hour limit.</p>
        <p class="mc-limit-body mc-limit-body--faint">Please contact the event host if you'd like to continue watching.</p>
        <div class="mc-limit-event-card">
          <p class="mc-limit-event-label">Event: <span id="limit-event-title"></span></p>
        </div>
      </div>
    `;
    document.body.appendChild(limitEl);
  }
  
  // Update event title
  const titleEl = limitEl.querySelector('#limit-event-title');
  if (titleEl && eventData) {
    titleEl.textContent = eventData.title;
  }
  
  limitEl.classList.remove('hidden');
}

// Show error state
function showError(message = 'Event not found') {
  // Hide loading state
  document.getElementById('loading').classList.add('hidden');
  
  // Show error
  const errorEl = document.getElementById('error');
  const errorMessage = errorEl.querySelector('p');
  if (errorMessage) {
    errorMessage.textContent = message;
  }
  errorEl.classList.remove('hidden');
}

// Update status badge based on event state
function updateStatusBadge() {
  const badge = document.querySelector('.ended-badge');
  if (!badge) return;
  
  if (eventData.status === 'live' && eventData.stream_state === 'active') {
    badge.textContent = 'LIVE';
    badge.className = 'live-badge';
  } else if (eventData.status === 'ready' && eventData.stream_state === 'disconnected') {
    badge.textContent = 'PAUSED';
    badge.className = 'paused-badge';
  } else if (eventData.status === 'ended') {
    badge.textContent = 'ENDED';
    badge.className = 'ended-badge';
  } else if (eventData.status === 'ready') {
    badge.textContent = 'READY';
    badge.className = 'ready-badge';
  }
}

function showExpired() {
  const countdownEl = document.getElementById('countdown');
  const titleEl = document.getElementById('event-title');
  const scheduledTimeEl = document.getElementById('scheduled-time');
  
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  
  titleEl.textContent = eventData.title;
  
  const scheduledDate = new Date(eventData.scheduled_date);
  scheduledTimeEl.textContent = `Held on ${scheduledDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })}`;
  
  // Note: showExpired() is a legacy fallback — showCountdownState('EXPIRED') is the
  // primary handler. This block kept for safety in case it's ever called directly.
  const timerContainer = countdownEl.querySelector('.grid');
  if (timerContainer) {
    timerContainer.innerHTML = `
      <div class="mc-expired-block">
        <p class="mc-expired-title">Recording No Longer Available</p>
        <p class="mc-expired-sub">Recordings are kept for 30 days after the event.</p>
      </div>
    `;
  }
  
  countdownEl.classList.remove('hidden');
}

/**
 * Apply the photographer's cover photo as a full-bleed background on the
 * given state element. Uses a dark gradient overlay so text stays legible.
 * No-op if no cover_image_url exists (existing dark background is preserved).
 */
/**
 * Inject the cover photo as a block-level image below the countdown content.
 * The photo flows naturally after the card so the subject's head is never cropped.
 * A gradient overlay blends the top edge into the solid-black countdown area.
 */
/**
 * Inject a full-bleed cover photo between the countdown card and the QR/footer.
 * The photo breaks out of .mc-center's max-width to go edge-to-edge.
 * QR, date, and powered-by sit on top of the photo via z-index layering.
 */
function applyCoverBackground(el) {
  if (!el || !eventData?.cover_image_url) return;

  // Don't duplicate if already injected
  if (el.querySelector('.mc-cover-photo-wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'mc-cover-photo-wrap';
  wrap.innerHTML = `
    <div class="mc-cover-gradient-top"></div>
    <img class="mc-cover-img" src="${eventData.cover_image_url}" alt="" />
    <div class="mc-cover-gradient-bottom"></div>
  `;

  // Insert into .mc-center, right after the countdown-timer card
  const center = el.querySelector('.mc-center');
  const timerCard = center?.querySelector('.countdown-timer');
  if (timerCard && timerCard.nextSibling) {
    center.insertBefore(wrap, timerCard.nextSibling);
  } else if (center) {
    center.appendChild(wrap);
  }

  el.classList.add('mc-cover-active');
}

/**
 * Remove cover photo element (used when transitioning to ENDED/EXPIRED states).
 */
function removeCoverBackground(el) {
  if (!el) return;
  const wrap = el.querySelector('.mc-cover-photo-wrap');
  if (wrap) wrap.remove();
  el.classList.remove('mc-cover-active');
}

// Start the app
init();