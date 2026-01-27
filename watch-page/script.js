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
      const readyRecordings = eventData.recordings.filter(r => r.readyToStream === true);
      
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
  
  // Only update UI if mode has changed or if we're not showing the right state
  if (newMode !== playbackMode) {
    console.log(`Playback mode changed: ${playbackMode} -> ${newMode}`);
    
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
        showEnded();
        break;
      case 'WAITING':
      default:
        showWaiting();
        break;
    }
  }
}

// Show waiting state (scheduled time passed, but stream not started)
function showWaiting() {
  const countdownEl = document.getElementById('countdown');
  const titleEl = document.getElementById('event-title');
  const scheduledTimeEl = document.getElementById('scheduled-time');
  
  // Clear any existing countdown interval
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  
  titleEl.textContent = eventData.title;
  
  const scheduledDate = new Date(eventData.scheduled_date);
  scheduledTimeEl.textContent = `Scheduled for ${scheduledDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })}`;
  
  // Replace countdown timer with waiting message
  const timerContainer = countdownEl.querySelector('.grid'); // Adjust selector to match your HTML
  if (timerContainer) {
    timerContainer.innerHTML = '<p class="text-2xl font-bold col-span-full">Event starting soon...</p>';
  }
  
  countdownEl.classList.remove('hidden');
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
      messageEl.className = 'text-2xl font-bold text-center mt-8';
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
  const streamEl = document.getElementById('live-stream');
  
  titleEl.textContent = eventData.title;
  
  console.log('Event data:', eventData);
  
  const liveInputId = eventData.live_input_id || eventData.liveinputid;
  
  if (liveInputId) {
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${liveInputId}/iframe?autoplay=true&muted=false`;
    
    // Only set src if it's different (prevents reload)
    if (streamEl.src !== embedUrl) {
      console.log('Setting iframe src to:', embedUrl);
      streamEl.src = embedUrl;
    }
  } else {
    console.error('No live_input_id found in eventData:', eventData);
  }

  // Check if stream is disconnected but recording is finalizing
  if (eventData.stream_state === 'disconnected' && eventData.status === 'live') {
    // Add processing overlay
    let processingOverlay = document.getElementById('processing-overlay');
    if (!processingOverlay) {
      processingOverlay = document.createElement('div');
      processingOverlay.id = 'processing-overlay';
      processingOverlay.className = 'absolute inset-0 bg-black/80 flex items-center justify-center z-10';
      processingOverlay.innerHTML = `
        <div class="text-center">
          <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p class="text-white text-lg">Processing recording...</p>
          <p class="text-gray-400 text-sm mt-2">This usually takes 1-2 minutes</p>
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

// Show processing state when recording is finalizing
function showProcessing() {
  const liveEl = document.getElementById('live');
  const titleEl = document.getElementById('live-title');
  
  titleEl.textContent = eventData.title;
  
  // Show a processing message instead of frozen player
  const streamContainer = document.getElementById('live-stream').parentElement;
  streamContainer.innerHTML = `
    <div class="flex items-center justify-center h-full bg-gray-900 rounded-lg">
      <div class="text-center p-8">
        <div class="animate-spin rounded-full h-16 w-16 border-b-2 border-purple-500 mx-auto mb-6"></div>
        <p class="text-white text-xl font-medium mb-2">Processing recording...</p>
        <p class="text-gray-400">Your stream will be ready for playback shortly</p>
        <p class="text-gray-500 text-sm mt-4">Usually takes 1-2 minutes</p>
      </div>
    </div>
  `;
  
  liveEl.classList.remove('hidden');
}

// Show last/most recent recording (< 2 hours since activity)
function showLastRecording() {
  const replayEl = document.getElementById('replay');
  const titleEl = document.getElementById('replay-title');
  const streamEl = document.getElementById('replay-stream');

  titleEl.textContent = eventData.title;

  console.log('Playing last recording (< 2hr timeout):', eventData.recordings);

  // Sort recordings by created timestamp (newest first) and filter for ready ones
  const recordings = [...eventData.recordings]
    .filter(recording => recording.readyToStream === true)
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
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${videoId}/iframe?autoplay=true&muted=false`;
    
    // Only set src if it's different (prevents reload on poll)
    if (streamEl.src !== embedUrl) {
      console.log('Setting last recording iframe src to:', embedUrl);
      streamEl.src = embedUrl;
    }
  } else {
    console.error('No recordings found in eventData:', eventData);
  }

  // Remove live banner if it exists
  const liveBanner = document.getElementById('live-banner');
  if (liveBanner) {
    liveBanner.remove();
  }
  
  // Add waiting message banner
  let waitingBanner = document.getElementById('waiting-banner');
  if (!waitingBanner) {
    waitingBanner = document.createElement('div');
    waitingBanner.id = 'waiting-banner';
    waitingBanner.className = 'bg-purple-600 text-white px-6 py-3 flex items-center justify-center gap-2 font-semibold w-full';
    
    // Calculate time since last activity for display
    let timeSinceText = '';
    if (eventData.last_stream_activity) {
      const lastActivity = new Date(eventData.last_stream_activity);
      const now = new Date();
      const minutesAgo = Math.floor((now - lastActivity) / (1000 * 60));
      timeSinceText = minutesAgo > 0 ? ` (${minutesAgo} min ago)` : '';
    }
    
    waitingBanner.innerHTML = `
      <span class="inline-block w-3 h-3 bg-white rounded-full animate-pulse"></span>
      <span>Stream paused${timeSinceText} - Photographer will return shortly...</span>
    `;
    
    // Insert banner at the very top of replay element
    if (replayEl.firstChild) {
      replayEl.insertBefore(waitingBanner, replayEl.firstChild);
    } else {
      replayEl.appendChild(waitingBanner);
    }
  }

  replayEl.classList.remove('hidden');
}

// Show sequential playback (> 2 hours since activity or event ended)
function showSequentialPlayback() {
  const replayEl = document.getElementById('replay');
  const titleEl = document.getElementById('replay-title');
  const streamEl = document.getElementById('replay-stream');

  titleEl.textContent = eventData.title;

  console.log('Playing sequential recordings:', eventData.recordings);

  // Sort recordings by created timestamp (oldest first) and filter for ready ones
  const allRecordings = [...eventData.recordings]
    .filter(recording => recording.readyToStream === true)
    .sort((a, b) => new Date(a.created) - new Date(b.created));
  
  // Reset index if it's beyond available recordings
  if (currentRecordingIndex >= allRecordings.length) {
    currentRecordingIndex = 0;
  }
  
  const videoId = allRecordings[currentRecordingIndex]?.uid;
  
  if (videoId) {
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${videoId}/iframe?autoplay=true&muted=false`;
    
    // Only set src if it's different (prevents reload on poll)
    if (streamEl.src !== embedUrl) {
      console.log(`Setting sequential playback iframe src (${currentRecordingIndex + 1}/${allRecordings.length}):`, embedUrl);
      streamEl.src = embedUrl;
      
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
    progressBanner.className = 'bg-gray-700 text-white px-6 py-3 text-sm w-full text-center';
    
    // Insert banner after the title element
    const titleEl = document.getElementById('replay-title');
    if (titleEl && titleEl.parentNode) {
      titleEl.parentNode.insertBefore(progressBanner, titleEl.nextSibling);
    }
  }
  
  // Update progress text
  const statusText = eventData.status === 'ended' ? 'Event Replay' : 'Event In Progress';
  progressBanner.innerHTML = `
    <span>${statusText} - Video <span id="current-video-num">${currentRecordingIndex + 1}</span> of ${recordings.length}</span>
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
        console.warn(`No timeupdate for ${timeSinceLastUpdate.toFixed(0)}s, video may be paused or ended`);
        
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
    // Show end message
    showAllRecordingsComplete();
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
    completionOverlay.className = 'absolute inset-0 bg-black bg-opacity-90 flex items-center justify-center z-10';
    completionOverlay.innerHTML = `
      <div class="text-center">
        <p class="text-2xl font-bold mb-4">All recordings complete</p>
        <p class="text-gray-400 mb-6">Thank you for watching!</p>
        <button onclick="location.reload()" class="bg-purple-600 hover:bg-purple-700 px-6 py-3 rounded-lg font-semibold">
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

  console.log('Replay data:', eventData.recordings);

  // Use oldest recording (last in array, since API returns newest first)
  const videoId = eventData.merged_video_id || (eventData.recordings[eventData.recordings.length - 1]?.uid);
  
  if (videoId) {
    const embedUrl = `https://customer-r5vkm8rpzqtdt9cz.cloudflarestream.com/${videoId}/iframe?autoplay=true&muted=false`;
    
    // Only set src if it's different (prevents reload on poll)
    if (streamEl.src !== embedUrl) {
      console.log('Setting replay iframe src to:', embedUrl);
      streamEl.src = embedUrl;
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

// Show ended state (event finished, no recordings)
function showEnded() {
  const countdownEl = document.getElementById('countdown');
  const titleEl = document.getElementById('event-title');
  const scheduledTimeEl = document.getElementById('scheduled-time');
  
  // Clear any existing countdown interval
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  
  titleEl.textContent = eventData.title;
  scheduledTimeEl.textContent = 'This event has ended';
  
  // Replace countdown timer with ended message
  const timerContainer = countdownEl.querySelector('.grid');
  if (timerContainer) {
    timerContainer.innerHTML = `
      <div class="col-span-full text-center">
        <p class="text-2xl font-bold mb-4">Event Has Ended</p>
        <p class="text-gray-400">Thank you for watching!</p>
      </div>
    `;
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
    limitEl.className = 'state min-h-screen flex items-center justify-center px-4';
    limitEl.innerHTML = `
      <div class="max-w-md mx-auto text-center">
        <div class="mb-8">
          <svg class="w-20 h-20 mx-auto text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
        </div>
        <h2 class="text-3xl font-bold mb-4">Viewing Limit Reached</h2>
        <p class="text-gray-400 text-lg mb-6">
          This event has reached its viewing hour limit.
        </p>
        <p class="text-gray-500 mb-8">
          Please contact the event host if you'd like to continue watching.
        </p>
        <div class="bg-gray-800 rounded-lg p-4">
          <p class="text-sm text-gray-400">Event: <span class="text-white font-medium" id="limit-event-title"></span></p>
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

// Start the app
init();