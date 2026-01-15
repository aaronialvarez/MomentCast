// Configuration
const API_URL = 'https://api.momentcast.live';

const slug = window.location.pathname.split('/').filter(Boolean).pop() || '';
// const slug = 'sofia-s-quince';

// State management
let eventData = null;
let countdownInterval = null;
let pollInterval = null;

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
  const pollFrequency = isLive ? 120000 : 60000; // Poll every 2 minutes when live, 1 min when scheduled
  
  // Only restart if frequency needs to change
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  
  pollInterval = setInterval(async () => {
    const previousState = eventData?.status;
    await fetchEvent();
    updateUI();
    
    // Restart polling only if state changed
    const newState = eventData?.status;
    if (previousState !== newState) {
      startPolling();
    }
  }, pollFrequency);
}

// Update UI based on event state
function updateUI() {
  if (!eventData) {
    showError();
    return;
  }

  const now = new Date();
  const scheduledDate = new Date(eventData.scheduled_date);
  const isLive = eventData.status === 'live' || eventData.stream_state === 'active';
  const hasEnded = eventData.status === 'ended';
  const hasRecordings = eventData.recordings && eventData.recordings.length > 0;

  // Hide all states
  document.querySelectorAll('.state').forEach(el => el.classList.add('hidden'));

  // Check if viewer limit exceeded (only for live/replay states)
  if ((isLive || (hasEnded && hasRecordings)) && eventData.limitExceeded) {
    showLimitExceeded();
    return;
  }

  if (isLive) {
    showLive();
  } else if (hasEnded && hasRecordings) {
    showReplay();
  } else if (now < scheduledDate) {
    showCountdown();
  } else {
    // Scheduled time has passed but event hasn't started
    showWaiting();
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
  
  liveEl.classList.remove('hidden');
}

// Show replay state
function showReplay() {
  const replayEl = document.getElementById('replay');
  const titleEl = document.getElementById('replay-title');
  const streamEl = document.getElementById('replay-stream');

  titleEl.textContent = eventData.title;

  // Use first recording or merged video
  const videoId = eventData.merged_video_id || (eventData.recordings[0]?.uid);
  
  if (videoId) {
    streamEl.src = `https://customer-${videoId.substring(0, 8)}.cloudflarestream.com/${videoId}/iframe`;
  }

  replayEl.classList.remove('hidden');
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