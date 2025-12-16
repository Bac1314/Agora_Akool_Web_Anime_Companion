// AI Anime Companion App
class AnimeCompanion {
  constructor() {
    this.client = null;
    this.localTracks = {
      audioTrack: null,
      videoTrack: null
    };
    this.remoteUsers = {};
    this.currentAgent = null;
    this.isConnecting = false;
    this.isConnected = false;
    this.transcriptManager = null;
    this.isTranscriptOpen = false;
    
    // UI Elements
    this.elements = {
      startBtn: document.getElementById('start-btn'),
      endBtn: document.getElementById('end-btn'),
      micBtn: document.getElementById('mic-btn'),
      cameraBtn: document.getElementById('camera-btn'),
      channelInput: document.getElementById('channel-input'),
      companionNameInput: document.getElementById('companion-name'),
      connectionForm: document.getElementById('connection-form'),
      conversationControls: document.getElementById('conversation-controls'),
      localVideoContainer: document.getElementById('local-video-container'),
      localVideo: document.getElementById('local-video'),
      avatarPlaceholder: document.getElementById('avatar-placeholder'),
      avatarVideo: document.getElementById('avatar-video'),
      connectionStatus: document.getElementById('connection-status'),
      statusDot: document.querySelector('.status-dot'),
      statusText: document.querySelector('.status-text'),
      loadingOverlay: document.getElementById('loading-overlay'),
      loadingText: document.getElementById('loading-text'),
      transcriptBtn: document.getElementById('transcript-btn'),
      transcriptOverlay: document.getElementById('transcript-overlay'),
      transcriptMessages: document.getElementById('transcript-messages'),
      transcriptInput: document.getElementById('transcript-input'),
      sendTranscriptBtn: document.getElementById('send-transcript-btn'),
      clearTranscriptBtn: document.getElementById('clear-transcript-btn'),
      closeTranscriptBtn: document.getElementById('close-transcript-btn')
    };
    
    this.init();
  }
  
  init() {
    // Initialize Agora client
    this.client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    
    // Initialize transcript manager
    if (window.TranscriptManager) {
      this.transcriptManager = new TranscriptManager(this);
    }
    
    // Bind event handlers
    this.bindEvents();
    
    // Set initial UI state
    this.updateConnectionStatus('offline', 'Offline');
    
    console.log('Anime Companion initialized');
  }
  
  bindEvents() {
    // Button events
    this.elements.startBtn.addEventListener('click', () => this.startConversation());
    this.elements.endBtn.addEventListener('click', () => this.endConversation());
    this.elements.micBtn.addEventListener('click', () => this.toggleMicrophone());
    this.elements.cameraBtn.addEventListener('click', () => this.toggleCamera());
    this.elements.transcriptBtn.addEventListener('click', () => this.toggleTranscript());
    this.elements.clearTranscriptBtn.addEventListener('click', () => this.clearTranscript());
    this.elements.sendTranscriptBtn.addEventListener('click', () => this.sendTranscriptMessage());
    this.elements.closeTranscriptBtn.addEventListener('click', () => this.closeTranscript());
    this.elements.transcriptInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendTranscriptMessage();
    });
    
    // Close transcript when clicking outside popup
    this.elements.transcriptOverlay.addEventListener('click', (e) => {
      if (e.target === this.elements.transcriptOverlay) this.closeTranscript();
    });
    
    // Agora client events
    this.client.on("user-published", (user, mediaType) => this.handleUserPublished(user, mediaType));
    this.client.on("user-unpublished", (user, mediaType) => this.handleUserUnpublished(user, mediaType));
    this.client.on("user-joined", (user) => this.handleUserJoined(user));
    this.client.on("user-left", (user) => this.handleUserLeft(user));
    this.client.on("stream-message", (uid, payload) => this.handleStreamMessage(uid, payload));

    // Form submission
    this.elements.startBtn.closest('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.startConversation();
    });
  }
  
  async startConversation() {
    if (this.isConnecting || this.isConnected) return;
    
    const channel = this.elements.channelInput.value.trim();
    const companionName = this.elements.companionNameInput.value.trim();
    
    if (!channel || !companionName) {
      alert('Please enter both channel name and companion name');
      return;
    }
    
    this.isConnecting = true;
    this.updateConnectionStatus('connecting', 'Connecting...');
    this.showLoading('Connecting to your AI companion...');
    this.elements.startBtn.disabled = true;
    
    try {
      // Step 1: Get channel info
      this.updateLoadingText('Getting channel information...');
      const channelInfo = await this.getChannelInfo(channel);
      
      // Step 2: Join Agora channel
      this.updateLoadingText('Joining voice channel...');
      await this.joinAgoraChannel(channelInfo);
      
      // Step 3: Start AI conversation
      this.updateLoadingText('Starting AI conversation...');
      const conversationResult = await this.startAIConversation(channel, companionName);
      
      // Step 4: Update UI for active conversation
      this.onConversationStarted(conversationResult);
      
    } catch (error) {
      console.error('Failed to start conversation:', error);
      this.updateConnectionStatus('offline', 'Connection failed');
      alert('Failed to start conversation: ' + (error.message || 'Unknown error'));
      this.resetToInitialState();
    }
  }
  
  async endConversation() {
    if (!this.isConnected) return;
    
    this.updateConnectionStatus('connecting', 'Disconnecting...');
    this.showLoading('Ending conversation...');
    
    try {
      // Stop AI agent if exists
      if (this.currentAgent?.agentId) {
        await this.stopAIConversation(this.currentAgent.agentId);
      }
      
      // Leave Agora channel
      await this.leaveAgoraChannel();
      
      // Reset UI
      this.resetToInitialState();
      
    } catch (error) {
      console.error('Error ending conversation:', error);
      this.resetToInitialState();
    }
  }
  
  async getChannelInfo(channel) {
    const uid = Math.floor(Math.random() * 100000) + 1000;
    const response = await fetch(`/api/agora/channel-info?channel=${encodeURIComponent(channel)}&uid=${uid}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get channel info: ${response.status}`);
    }
    
    return await response.json();
  }
  
  async joinAgoraChannel(channelInfo) {
    // Create local tracks
    [this.localTracks.audioTrack, this.localTracks.videoTrack] = await Promise.all([
      AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: {
          sampleRate: 48000,
          stereo: true,
          bitrate: 128,
        }
      }),
      AgoraRTC.createCameraVideoTrack({
        encoderConfig: {
          width: 640,
          height: 480,
          frameRate: 30,
          bitrateMax: 1000,
        }
      })
    ]);
    
    // Join channel
    const uid = await this.client.join(
      channelInfo.appId,
      channelInfo.channel,
      null, // token
      channelInfo.uid
    );
    
    // Play local video
    this.localTracks.videoTrack.play(this.elements.localVideo);
    
    // Publish tracks
    await this.client.publish([this.localTracks.audioTrack, this.localTracks.videoTrack]);
    
    console.log('Joined Agora channel successfully, UID:', uid);
    return uid;
  }
  
  async startAIConversation(channel, agentName) {
    const response = await fetch('/api/agora/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: channel,
        agentName: agentName,
        remoteUid: this.client.uid
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    
    return await response.json();
  }
  
  async stopAIConversation(agentId) {
    const response = await fetch(`/api/agora/stop/${agentId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.warn('Failed to stop AI agent:', response.status);
    }
    
    return response.ok;
  }
  
  async leaveAgoraChannel() {
    // Stop and close local tracks
    if (this.localTracks.audioTrack) {
      this.localTracks.audioTrack.stop();
      this.localTracks.audioTrack.close();
      this.localTracks.audioTrack = null;
    }
    
    if (this.localTracks.videoTrack) {
      this.localTracks.videoTrack.stop();
      this.localTracks.videoTrack.close();
      this.localTracks.videoTrack = null;
    }
    
    // Clear remote users
    this.remoteUsers = {};
    
    // Leave channel
    if (this.client) {
      await this.client.leave();
    }
    
    console.log('Left Agora channel');
  }
  
  onConversationStarted(result) {
    this.isConnecting = false;
    this.isConnected = true;
    this.currentAgent = result;
    
    // Update UI
    this.updateConnectionStatus('online', `Connected to ${this.elements.companionNameInput.value}`);
    this.hideLoading();
    this.switchToConversationMode();
    
    // Initialize transcript
    if (this.transcriptManager) {
      this.transcriptManager.clearTranscript();
    }
    this.addChatMessage('System', `Conversation started with ${this.elements.companionNameInput.value}`, 'system');
    
    // Show demo message if in demo mode
    if (result.demo) {
      this.showDemoMessage(result.message);
      this.addChatMessage('System', `Demo Mode: ${result.message}`, 'system');
    }
    
    console.log('Conversation started:', result);
  }
  
  resetToInitialState() {
    this.isConnecting = false;
    this.isConnected = false;
    this.currentAgent = null;
    
    this.updateConnectionStatus('offline', 'Offline');
    this.hideLoading();
    this.switchToConnectionMode();
    this.elements.startBtn.disabled = false;
    
    // Close transcript overlay
    this.closeTranscript();
    
    // Add disconnect message to transcript
    if (this.elements.transcriptMessages.children.length > 0) {
      this.addChatMessage('System', 'Conversation ended', 'system');
    }
  }
  
  switchToConversationMode() {
    this.elements.connectionForm.style.display = 'none';
    this.elements.conversationControls.style.display = 'block';
    this.elements.localVideoContainer.style.display = 'block';
    this.elements.avatarPlaceholder.style.display = 'none';
  }
  
  switchToConnectionMode() {
    this.elements.connectionForm.style.display = 'block';
    this.elements.conversationControls.style.display = 'none';
    this.elements.localVideoContainer.style.display = 'none';
    this.elements.avatarPlaceholder.style.display = 'flex';
    this.elements.avatarVideo.style.display = 'none';
  }
  
  async toggleMicrophone() {
    if (!this.localTracks.audioTrack) return;
    
    const enabled = this.localTracks.audioTrack.enabled;
    await this.localTracks.audioTrack.setEnabled(!enabled);
    
    if (enabled) {
      this.elements.micBtn.classList.remove('active');
      this.elements.micBtn.style.opacity = '0.5';
    } else {
      this.elements.micBtn.classList.add('active');
      this.elements.micBtn.style.opacity = '1';
    }
  }
  
  async toggleCamera() {
    if (!this.localTracks.videoTrack) return;
    
    const enabled = this.localTracks.videoTrack.enabled;
    await this.localTracks.videoTrack.setEnabled(!enabled);
    
    if (enabled) {
      this.elements.cameraBtn.classList.remove('active');
      this.elements.cameraBtn.style.opacity = '0.5';
    } else {
      this.elements.cameraBtn.classList.add('active');
      this.elements.cameraBtn.style.opacity = '1';
    }
  }
  
  handleUserJoined(user) {
    console.log('User joined:', user.uid);
  }
  
  handleUserLeft(user) {
    console.log('User left:', user.uid);
    delete this.remoteUsers[user.uid];
  }
  
  async handleUserPublished(user, mediaType) {
    console.log('User published:', user.uid, mediaType);
    
    this.remoteUsers[user.uid] = user;
    
    // Subscribe to the user
    await this.client.subscribe(user, mediaType);
    
    if (mediaType === 'video') {
      // Show avatar video
      this.elements.avatarPlaceholder.style.display = 'none';
      this.elements.avatarVideo.style.display = 'block';
      user.videoTrack.play(this.elements.avatarVideo);
    }
    
    if (mediaType === 'audio') {
      // Play audio
      user.audioTrack.play();
    }
  }
  
  handleUserUnpublished(user, mediaType) {
    console.log('User unpublished:', user.uid, mediaType);
    
    if (mediaType === 'video') {
      // Hide avatar video
      this.elements.avatarVideo.style.display = 'none';
      this.elements.avatarPlaceholder.style.display = 'flex';
    }
  }

  handleStreamMessage(uid, payload) {
    console.log('Stream message from', uid, payload);
    
    // Delegate to transcript manager if available
    if (this.transcriptManager) {
      this.transcriptManager.handleStreamMessage(uid, payload);
    }
  }
  
  // Method for transcript manager to call to update UI
  addChatMessage(speaker, message, type = 'final') {
    const transcriptMessages = this.elements.transcriptMessages;
    const messageElement = document.createElement('div');
    messageElement.className = `transcript-message ${type}`;
    
    const timestamp = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    messageElement.innerHTML = `
      <div class="message-header">
        <span class="speaker">${speaker}</span>
        <span class="timestamp">${timestamp}</span>
      </div>
      <div class="message-content">${message}</div>
    `;
    
    transcriptMessages.appendChild(messageElement);
    
    // Auto-scroll to bottom
    transcriptMessages.scrollTop = transcriptMessages.scrollHeight;
    
    // Limit transcript history to last 100 messages for performance
    const messages = transcriptMessages.children;
    if (messages.length > 100) {
      transcriptMessages.removeChild(messages[0]);
    }
  }
  
  // Transcript overlay methods
  toggleTranscript() {
    if (this.isTranscriptOpen) {
      this.closeTranscript();
    } else {
      this.openTranscript();
    }
  }
  
  openTranscript() {
    this.elements.transcriptOverlay.style.display = 'flex';
    this.elements.transcriptBtn.classList.add('active');
    this.isTranscriptOpen = true;
    
    // Focus input if connected
    if (this.isConnected) {
      setTimeout(() => {
        this.elements.transcriptInput.focus();
      }, 100);
    }
  }
  
  closeTranscript() {
    this.elements.transcriptOverlay.style.display = 'none';
    this.elements.transcriptBtn.classList.remove('active');
    this.isTranscriptOpen = false;
  }
  
  async sendTranscriptMessage() {
    const message = this.elements.transcriptInput.value.trim();
    if (!message || !this.isConnected) return;
    
    // Send via transcript manager
    if (this.transcriptManager) {
      const success = await this.transcriptManager.sendMessageToAI(message);
      if (success) {
        this.elements.transcriptInput.value = '';
      } else {
        console.error('Failed to send message to AI');
      }
    }
  }
  
  clearTranscript() {
    this.elements.transcriptMessages.innerHTML = '';
    if (this.transcriptManager) {
      this.transcriptManager.clearTranscript();
    }
    this.addChatMessage('System', 'Transcript cleared', 'system');
  }
  
  updateConnectionStatus(status, text) {
    this.elements.statusDot.className = `status-dot ${status}`;
    this.elements.statusText.textContent = text;
  }
  
  showLoading(text = 'Loading...') {
    this.updateLoadingText(text);
    this.elements.loadingOverlay.style.display = 'flex';
  }
  
  hideLoading() {
    this.elements.loadingOverlay.style.display = 'none';
  }
  
  updateLoadingText(text) {
    this.elements.loadingText.textContent = text;
  }
  
  showDemoMessage(message) {
    // Create a simple toast notification
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #ffc107;
      color: #000;
      padding: 1rem;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 1001;
      max-width: 300px;
      font-size: 0.9rem;
    `;
    toast.textContent = `Demo Mode: ${message}`;
    
    document.body.appendChild(toast);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
      document.body.removeChild(toast);
    }, 5000);
  }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.animeCompanion = new AnimeCompanion();
});