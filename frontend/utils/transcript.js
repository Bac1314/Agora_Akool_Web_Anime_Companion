// Transcript utilities for handling Agora ConvoAI stream messages
class TranscriptManager {
  constructor(animeCompanion) {
    this.companion = animeCompanion;
    this.transcriptHistory = [];
    this.currentInterimMessage = null;
  }

  // Parse and handle stream message data from Agora ConvoAI
  handleStreamMessage(uid, payload) {
    try {
      let messageData;
      
      if (typeof payload === 'string') {
        // Try parsing as JSON first
        try {
          messageData = JSON.parse(payload);
        } catch {
          // If not JSON, treat as raw text
          messageData = { type: 'raw_text', text: payload };
        }
      } else if (payload instanceof Uint8Array) {
        // Convert Uint8Array to string
        const decoder = new TextDecoder();
        const decodedString = decoder.decode(payload);
        
        // Check if this is Agora ConvoAI protocol format (pipe-delimited)
        if (decodedString.includes('|')) {
          messageData = this.parseAgoraConvoAIMessage(decodedString);
        } else {
          // Try parsing as JSON
          try {
            messageData = JSON.parse(decodedString);
          } catch {
            // If not JSON, treat as raw text
            messageData = { type: 'raw_text', text: decodedString };
          }
        }
      } else {
        messageData = payload;
      }

      // Handle different message types from Agora ConvoAI
      this.processMessage(messageData, uid);
      
    } catch (error) {
      console.error('Error parsing stream message:', error);
      console.log('Raw payload:', payload);
      
      // Show error in transcript for debugging
      this.addTranscriptMessage('System', `Error parsing message: ${error.message}`, 'system');
    }
  }

  // Parse Agora ConvoAI custom message format
  parseAgoraConvoAIMessage(message) {
    try {
      // Agora ConvoAI format appears to be: id|version|type|base64_data
      const parts = message.split('|');
      
      if (parts.length >= 4) {
        const messageId = parts[0];
        const version = parts[1];
        const messageType = parts[2];
        const base64Data = parts.slice(3).join('|'); // Rejoin in case there are more pipes in data
        
        // Decode base64 data
        try {
          const decodedData = atob(base64Data);
          const jsonData = JSON.parse(decodedData);
          
          // Add metadata from protocol
          jsonData._messageId = messageId;
          jsonData._version = version;
          jsonData._messageType = messageType;
          
          return jsonData;
        } catch (base64Error) {
          console.warn('Failed to decode base64 data:', base64Error);
          return {
            type: 'agora_protocol',
            messageId,
            version,
            messageType,
            rawData: base64Data,
            text: `Protocol message: ${messageType}`
          };
        }
      } else {
        // Unknown format, treat as raw text
        return {
          type: 'raw_text',
          text: message
        };
      }
    } catch (error) {
      console.error('Error parsing Agora ConvoAI message:', error);
      return {
        type: 'parse_error',
        text: `Parse error: ${message.substring(0, 100)}...`,
        error: error.message
      };
    }
  }

  // Process different types of messages from Agora ConvoAI
  processMessage(data, uid) {
    const messageType = data.type || this.inferMessageType(data);
    
    // Log for debugging with uid context
    console.log(`Processing message from UID ${uid}:`, messageType, data);
    
    switch (messageType) {
      case 'transcript':
        this.handleTranscriptMessage(data);
        break;
      case 'agent_thinking':
        this.handleAgentThinking(data);
        break;
      case 'agent_response':
        this.handleAgentResponse(data);
        break;
      case 'user_speech':
        this.handleUserSpeech(data);
        break;
      case 'conversation_state':
        this.handleConversationState(data);
        break;
      default:
        console.log('Unknown message type:', messageType, data);
        break;
    }
  }

  // Infer message type from data structure
  inferMessageType(data) {
    if (data.transcript || data.text) {
      if (data.role === 'user' || data.speaker === 'user') return 'user_speech';
      if (data.role === 'assistant' || data.speaker === 'assistant') return 'agent_response';
      return 'transcript';
    }
    if (data.thinking || data.state === 'thinking') return 'agent_thinking';
    if (data.response) return 'agent_response';
    if (data.conversation_state) return 'conversation_state';
    return 'unknown';
  }

  // Handle transcript messages (speech-to-text)
  handleTranscriptMessage(data) {
    const text = data.transcript || data.text || data.content;
    const speaker = this.normalizeSpeaker(data.speaker || data.role || 'Unknown');
    const isFinal = data.is_final !== false; // Default to true
    const messageId = data.id || data.message_id;

    if (!text || !text.trim()) return;

    if (isFinal) {
      // Remove any interim message for this speaker
      if (this.currentInterimMessage && this.currentInterimMessage.speaker === speaker) {
        this.currentInterimMessage = null;
      }
      
      // Add final message
      this.addTranscriptMessage(speaker, text.trim(), 'final', messageId);
    } else {
      // Handle interim message
      this.currentInterimMessage = { speaker, text: text.trim(), id: messageId };
      this.addTranscriptMessage(speaker, text.trim(), 'interim', messageId);
    }
  }

  // Handle agent thinking state
  handleAgentThinking(data) {
    const text = data.thinking || 'AI is thinking...';
    this.addTranscriptMessage('System', text, 'thinking');
  }

  // Handle agent responses
  handleAgentResponse(data) {
    const text = data.response || data.text || data.content;
    if (text && text.trim()) {
      this.addTranscriptMessage('AI Companion', text.trim(), 'agent');
    }
  }

  // Handle user speech
  handleUserSpeech(data) {
    const text = data.text || data.content || data.transcript;
    if (text && text.trim()) {
      this.addTranscriptMessage('You', text.trim(), 'user');
    }
  }

  // Handle conversation state changes
  handleConversationState(data) {
    const state = data.conversation_state || data.state;
    this.addTranscriptMessage('System', `Conversation state: ${state}`, 'system');
  }

  // Normalize speaker names
  normalizeSpeaker(speaker) {
    const speakerMap = {
      'user': 'You',
      'assistant': 'AI Companion',
      'agent': 'AI Companion',
      'system': 'System'
    };
    return speakerMap[speaker.toLowerCase()] || speaker;
  }

  // Add message to transcript and UI
  addTranscriptMessage(speaker, message, type = 'final', messageId = null) {
    const transcriptMessage = {
      id: messageId || Date.now() + Math.random(),
      speaker,
      message,
      type,
      timestamp: new Date()
    };

    // Add to history
    this.transcriptHistory.push(transcriptMessage);

    // Update UI through companion
    if (this.companion && this.companion.addChatMessage) {
      this.companion.addChatMessage(speaker, message, type);
    }

    // Keep history manageable
    if (this.transcriptHistory.length > 200) {
      this.transcriptHistory = this.transcriptHistory.slice(-150);
    }
  }

  // Get transcript history
  getTranscriptHistory() {
    return this.transcriptHistory;
  }

  // Clear transcript
  clearTranscript() {
    this.transcriptHistory = [];
    this.currentInterimMessage = null;
  }

  // Send message to AI via Agora datastream
  async sendMessageToAI(message) {
    if (!this.companion || !this.companion.client) {
      console.error('No Agora client available');
      return false;
    }

    try {
      const messageData = {
        type: 'user_message',
        text: message,
        timestamp: Date.now(),
        sender: 'user'
      };

      // Convert message to Uint8Array for Agora datastream
      const encoder = new TextEncoder();
      const messageBuffer = encoder.encode(JSON.stringify(messageData));

      // Send via Agora datastream to all users in channel
      // This sends the message to the AI agent via RTC datastream
      await this.companion.client.sendStreamMessage(messageBuffer);
      
      // Add to local transcript immediately
      this.addTranscriptMessage('You', message, 'user');
      
      console.log('Message sent to AI via datastream:', message);
      return true;
    } catch (error) {
      console.error('Failed to send message to AI via datastream:', error);
      
      // Fallback: try sending as string if buffer fails
      try {
        await this.companion.client.sendStreamMessage(JSON.stringify({
          type: 'user_message',
          text: message,
          timestamp: Date.now(),
          sender: 'user'
        }));
        
        this.addTranscriptMessage('You', message, 'user');
        console.log('Message sent to AI via datastream (fallback):', message);
        return true;
      } catch (fallbackError) {
        console.error('Fallback datastream send also failed:', fallbackError);
        
        // Show error to user
        this.addTranscriptMessage('System', `Failed to send message: ${error.message}`, 'system');
        return false;
      }
    }
  }
}

// Export for use in main application
window.TranscriptManager = TranscriptManager;