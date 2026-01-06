// Transcript Manager based on Agora's Conversational AI Demo
// Reference: https://github.com/AgoraIO-Community/Conversational-AI-Demo/blob/main/Web/Scenes/VoiceAgent/src/conversational-ai-api/helper/transcript.ts

const DEFAULT_MESSAGE_CACHE_TIMEOUT = 1000 * 60 * 5; // 5 minutes
const DEFAULT_INTERVAL = 200; // milliseconds
const CONSOLE_LOG_PREFIX = '[TranscriptHelper]';

// Enumerations matching Agora's implementation
const ETurnStatus = {
  IN_PROGRESS: 0,
  END: 1,
  INTERRUPTED: 2
};

const ETranscriptionObjectType = {
  USER_TRANSCRIPTION: 'user.transcription',
  AGENT_TRANSCRIPTION: 'assistant.transcription',
  MSG_INTERRUPTED: 'message.interrupt',
  MSG_STATE: 'message.state'
};

const EAgentState = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  SILENT: 'silent'
};

const EMessageServiceMode = {
  UNKNOWN: 'UNKNOWN',
  TEXT: 'TEXT',
  WORD: 'WORD'
};

/**
 * MessageService - Handles chunked message assembly
 * @deprecated Use MessageServiceV2 instead
 */
class MessageService {
  constructor(options = {}) {
    this._messageCache = {};
    this._messageCacheTimeout = options.messageCacheTimeout ?? DEFAULT_MESSAGE_CACHE_TIMEOUT;
  }

  /**
   * Convert Uint8Array stream to string chunk
   */
  streamMessage2Chunk(stream) {
    const decoder = new TextDecoder();
    return decoder.decode(stream);
  }

  /**
   * Handle message chunk
   * Format: {message_id}|{part_idx}|{part_sum}|{part_data}
   * @param {number} uid - User ID
   * @param {string} chunk - Chunk string
   * @param {Function} callback - Callback when message is complete
   */
  handleChunk(uid, chunk, callback) {
    try {
      // Split chunk by '|'
      const [msgId, partIdx, partSum, ...rest] = chunk.split('|');
      const partData = rest.join('|'); // Rejoin in case content contains '|'

      const input = {
        message_id: msgId,
        part_idx: parseInt(partIdx, 10),
        part_sum: partSum === '???' ? -1 : parseInt(partSum, 10),
        content: partData
      };

      // Check if total parts is known, skip if unknown
      if (input.part_sum === -1) {
        console.debug(CONSOLE_LOG_PREFIX, 'total parts unknown, waiting for further parts.');
        return;
      }

      // Initialize cache for this message
      if (!this._messageCache[input.message_id]) {
        this._messageCache[input.message_id] = [];

        // Set cache timeout
        setTimeout(() => {
          if (
            this._messageCache[input.message_id] &&
            this._messageCache[input.message_id].length < input.part_sum
          ) {
            console.debug(
              CONSOLE_LOG_PREFIX,
              input.message_id,
              'message cache timeout, drop it.'
            );
            delete this._messageCache[input.message_id];
          }
        }, this._messageCacheTimeout);
      }

      // Add to cache if not already present (unique push)
      if (
        !this._messageCache[input.message_id]?.find(
          (item) => item.part_idx === input.part_idx
        )
      ) {
        this._messageCache[input.message_id].push(input);
      }

      // Sort by part_idx
      this._messageCache[input.message_id].sort((a, b) => a.part_idx - b.part_idx);

      // Check if complete
      if (this._messageCache[input.message_id].length === input.part_sum) {
        const message = this._messageCache[input.message_id]
          .map((chunk) => chunk.content)
          .join('');

        // Decode base64 message
        try {
          console.debug(CONSOLE_LOG_PREFIX, '[message]', atob(message));
          const decodedMessage = JSON.parse(atob(message));
          console.debug(CONSOLE_LOG_PREFIX, '[decodedMessage]', decodedMessage);

          // Callback with decoded message
          callback?.(uid, decodedMessage);

          // Delete cache
          delete this._messageCache[input.message_id];
        } catch (error) {
          console.error(CONSOLE_LOG_PREFIX, 'Failed to decode message:', error);
        }
      }
    } catch (error) {
      console.error(CONSOLE_LOG_PREFIX, 'handleChunk error', error);
    }
  }

  cleanMessageCache() {
    this._messageCache = {};
  }
}

/**
 * MessageServiceV2 - Advanced message service with word-level support
 */
class MessageServiceV2 extends MessageService {
  static _version = '1.4.0';
  static localUserId = 0;

  constructor(options = {}) {
    super(options);
    this.chatHistory = [];
    this._mode = EMessageServiceMode.UNKNOWN;
    this._queue = [];
    this._interval = options.interval ?? DEFAULT_INTERVAL;
    this._intervalRef = null;
    this._pts = 0; // Current presentation timestamp
    this._lastPoppedQueueItem = null;
    this._isRunning = false;
    this._agentMessageState = null;
    this._legacyMode = false;
    this.onChatHistoryUpdated = options.onChatHistoryUpdated ?? null;
    this.onAgentStateChange = options.onAgentStateChange ?? null;

    console.info(
      CONSOLE_LOG_PREFIX,
      'initialized',
      `version: ${MessageServiceV2._version}`
    );
  }

  run(options = {}) {
    console.info(
      CONSOLE_LOG_PREFIX,
      'Message service is running',
      `version: ${MessageServiceV2._version}`
    );
    this._isRunning = true;
    this._legacyMode = options.legacyMode ?? false;
  }

  setupInterval() {
    if (!this._isRunning) {
      console.error(CONSOLE_LOG_PREFIX, 'Message service is not running');
      return;
    }
    if (this._intervalRef) {
      clearInterval(this._intervalRef);
      this._intervalRef = null;
    }
    this._intervalRef = setInterval(() => this._handleQueue(), this._interval);
  }

  teardownInterval() {
    if (this._intervalRef) {
      clearInterval(this._intervalRef);
      this._intervalRef = null;
    }
  }

  setPts(pts) {
    if (this._pts < pts && pts !== 0) {
      this._pts = pts;
    }
  }

  handleStreamMessage(uid, stream) {
    if (!this._isRunning) {
      console.warn(CONSOLE_LOG_PREFIX, 'Message service is not running');
      return;
    }
    const chunk = this.streamMessage2Chunk(stream);
    if (this._legacyMode) {
      this.handleChunk(uid, chunk, (uid, msg) => this.handleMessageLegacy(uid, msg));
      return;
    }
    this.handleChunk(uid, chunk, (uid, msg) => this.handleMessage(uid, msg));
  }

  /**
   * Handle message (legacy format)
   * @deprecated
   */
  handleMessageLegacy(uid, message) {
    const isTextValid = message?.text && message.text?.trim().length > 0;
    if (!isTextValid) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        '[handleMessageLegacy]',
        'Drop message with empty text',
        message
      );
      return;
    }

    const lastEndedItem = this.chatHistory.findLast(
      (item) =>
        item.stream_id === message.stream_id && item.status === ETurnStatus.END
    );
    const lastInProgressItem = this.chatHistory.findLast(
      (item) =>
        item.stream_id === message.stream_id &&
        item.status === ETurnStatus.IN_PROGRESS
    );

    if (lastEndedItem) {
      if (lastEndedItem._time >= message.text_ts) {
        console.debug(CONSOLE_LOG_PREFIX, '[handleMessageLegacy] discard lastEndedItem');
        return;
      } else {
        if (lastInProgressItem) {
          lastInProgressItem._time = message.text_ts;
          lastInProgressItem.text = message.text;
          lastInProgressItem.status = message.is_final
            ? ETurnStatus.END
            : ETurnStatus.IN_PROGRESS;
        } else {
          this._appendChatHistory({
            uid: message.stream_id
              ? `${MessageServiceV2.localUserId}`
              : `${uid}`,
            stream_id: message.stream_id,
            turn_id: message.text_ts,
            _time: message.text_ts,
            text: message.text,
            status: message.is_final ? ETurnStatus.END : ETurnStatus.IN_PROGRESS,
            metadata: null
          });
        }
      }
    } else {
      if (lastInProgressItem) {
        lastInProgressItem._time = message.text_ts;
        lastInProgressItem.text = message.text;
        lastInProgressItem.status = message.is_final
          ? ETurnStatus.END
          : ETurnStatus.IN_PROGRESS;
      } else {
        this._appendChatHistory({
          uid: message.stream_id ? `${MessageServiceV2.localUserId}` : `${uid}`,
          stream_id: message.stream_id,
          turn_id: message.text_ts,
          _time: message.text_ts,
          text: message.text,
          status: message.is_final ? ETurnStatus.END : ETurnStatus.IN_PROGRESS,
          metadata: null
        });
      }
    }

    this.chatHistory.sort((a, b) => a._time - b._time);
    this._mutateChatHistory();
  }

  /**
   * Handle incoming message
   */
  handleMessage(uid, message) {
    const isAgentMessage =
      message.object === ETranscriptionObjectType.AGENT_TRANSCRIPTION;
    const isUserMessage =
      message.object === ETranscriptionObjectType.USER_TRANSCRIPTION;
    const isMessageInterrupt =
      message.object === ETranscriptionObjectType.MSG_INTERRUPTED;
    const isMessageState = message.object === ETranscriptionObjectType.MSG_STATE;

    if (
      !isAgentMessage &&
      !isUserMessage &&
      !isMessageInterrupt &&
      !isMessageState
    ) {
      console.debug(CONSOLE_LOG_PREFIX, 'Unknown message type', message);
      return;
    }

    // Set mode (only once)
    if (isAgentMessage && this._mode === EMessageServiceMode.UNKNOWN) {
      if (!message.words || message.words.length === 0) {
        this.setMode(EMessageServiceMode.TEXT);
      } else {
        this.setupInterval();
        this.setMode(EMessageServiceMode.WORD);
      }
    }

    // Handle Agent Message
    if (isAgentMessage && this._mode === EMessageServiceMode.WORD) {
      this.handleWordAgentMessage(uid, message);
      return;
    }
    if (isAgentMessage && this._mode === EMessageServiceMode.TEXT) {
      this.handleTextMessage(uid, message);
      return;
    }

    // Handle User Message
    if (isUserMessage) {
      this.handleTextMessage(uid, message);
      return;
    }

    // Handle Message Interrupt
    if (isMessageInterrupt) {
      this.handleMessageInterrupt(uid, message);
      return;
    }

    if (isMessageState) {
      this.handleAgentStatus(message);
      return;
    }

    console.error(CONSOLE_LOG_PREFIX, 'Unknown mode', message);
  }

  handleTextMessage(uid, message) {
    const turn_id = message.turn_id;

    // Construct text from words array if available, otherwise use text field
    let text = message.text || '';
    if (message.words && message.words.length > 0) {
      text = message.words.map(word => word.word).join('');
    }

    const stream_id = message.stream_id;
    const turn_status = ETurnStatus.END;

    const targetChatHistoryItem = this.chatHistory.find(
      (item) => item.turn_id === turn_id && item.stream_id === stream_id
    );

    if (!targetChatHistoryItem) {
      this._appendChatHistory({
        turn_id,
        uid: message.stream_id ? `${MessageServiceV2.localUserId}` : `${uid}`,
        stream_id,
        _time: new Date().getTime(),
        text,
        status: turn_status,
        metadata: message
      });
    } else {
      targetChatHistoryItem.text = text;
      targetChatHistoryItem.status = turn_status;
      targetChatHistoryItem.metadata = message;
      targetChatHistoryItem._time = new Date().getTime();
    }

    this._mutateChatHistory();
  }

  handleMessageInterrupt(uid, message) {
    console.debug(CONSOLE_LOG_PREFIX, 'handleMessageInterrupt', uid, message);
    const turn_id = message.turn_id;
    const start_ms = message.start_ms;
    this._interruptQueue({ turn_id, start_ms });
    this._mutateChatHistory();
  }

  handleAgentStatus(message) {
    const prevMessageState = this._agentMessageState;
    console.debug(
      CONSOLE_LOG_PREFIX,
      'handleAgentStatus',
      'prevMessageState',
      prevMessageState,
      'currentMessageState',
      message
    );

    const currentMsgId = message.message_id;

    // Check if message is the same as previous one
    if (this._agentMessageState?.message_id === currentMsgId) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'handleAgentStatus',
        'ignore same message',
        currentMsgId
      );
      return;
    }

    // Check if message is older by turn_id
    const currentTurnId = message.turn_id;
    if ((this._agentMessageState?.turn_id || 0) > currentTurnId) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'handleAgentStatus',
        'ignore older message(turn_id)',
        currentTurnId
      );
      return;
    }

    // Check if message is older by ts_ms
    const currentMsgTs = message.ts_ms;
    if ((this._agentMessageState?.ts_ms || 0) >= currentMsgTs) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'handleAgentStatus',
        'ignore older message(ts_ms)',
        currentMsgTs
      );
      return;
    }

    console.debug(
      CONSOLE_LOG_PREFIX,
      'handleAgentStatus',
      'set current message state',
      message
    );

    this._agentMessageState = message;
    this.onAgentStateChange?.(message);
  }

  handleWordAgentMessage(uid, message) {
    // Drop message if turn_status is undefined
    if (typeof message.turn_status === 'undefined') {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'Drop message with undefined turn_status',
        message
      );
      return;
    }

    console.debug(
      CONSOLE_LOG_PREFIX,
      'handleWordAgentMessage',
      JSON.stringify(message)
    );

    const turn_id = message.turn_id;
    const text = message.text || '';
    const words = message.words || [];
    const stream_id = message.stream_id;
    const lastPoppedQueueItemTurnId = this._lastPoppedQueueItem?.turn_id;

    // Drop message if turn_id is less than last popped queue item
    // except for the first turn (greeting message, turn_id is 0)
    if (
      lastPoppedQueueItemTurnId &&
      turn_id !== 0 &&
      turn_id <= lastPoppedQueueItemTurnId
    ) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'Drop message with turn_id less than last popped queue item',
        uid,
        message
      );
      return;
    }

    this._pushToQueue({
      turn_id,
      words,
      text,
      status: message.turn_status,
      stream_id,
      uid: message.stream_id ? MessageServiceV2.localUserId : Number(uid)
    });
  }

  sortWordsWithStatus(words, turn_status) {
    if (words.length === 0) {
      return words;
    }

    const sortedWords = words
      .map((word) => ({
        ...word,
        word_status: ETurnStatus.IN_PROGRESS
      }))
      .sort((a, b) => a.start_ms - b.start_ms)
      .reduce((acc, curr) => {
        // Only add if start_ms is unique
        if (!acc.find((word) => word.start_ms === curr.start_ms)) {
          acc.push(curr);
        }
        return acc;
      }, []);

    const isMessageFinal = turn_status !== ETurnStatus.IN_PROGRESS;
    if (isMessageFinal) {
      sortedWords[sortedWords.length - 1].word_status = turn_status;
    }

    return sortedWords;
  }

  setMode(mode) {
    if (this._mode !== EMessageServiceMode.UNKNOWN) {
      console.warn(
        CONSOLE_LOG_PREFIX,
        'Mode should only be set once, but it is set again',
        'current mode:',
        this._mode
      );
      return;
    }
    if (mode === EMessageServiceMode.UNKNOWN) {
      throw new Error('Unknown mode should not be set');
    }
    this._mode = mode;
  }

  cleanup() {
    console.debug(CONSOLE_LOG_PREFIX, 'Cleanup message service');
    this._isRunning = false;
    this._legacyMode = false;
    this.cleanMessageCache();
    this.teardownInterval();
    this._queue = [];
    this._lastPoppedQueueItem = null;
    this._pts = 0;
    this.chatHistory = [];
    this._mode = EMessageServiceMode.UNKNOWN;
    this._agentMessageState = null;
  }

  _pushToQueue(data) {
    const targetQueueItem = this._queue.find(
      (item) => item.turn_id === data.turn_id
    );
    const latestTurnId = this._queue.reduce((max, item) => {
      return Math.max(max, item.turn_id);
    }, 0);

    if (!targetQueueItem) {
      // Drop if turn_id is less than latestTurnId
      if (data.turn_id < latestTurnId) {
        console.debug(
          CONSOLE_LOG_PREFIX,
          'Drop message with turn_id less than latestTurnId',
          data
        );
        return;
      }

      const newQueueItem = {
        turn_id: data.turn_id,
        text: data.text,
        words: this.sortWordsWithStatus(data.words, data.status),
        status: data.status,
        stream_id: data.stream_id,
        uid: data.uid
      };

      console.debug(
        CONSOLE_LOG_PREFIX,
        'Push to queue',
        newQueueItem,
        JSON.stringify(newQueueItem)
      );

      this._queue.push(newQueueItem);
      return;
    }

    // Update existing queue item
    console.debug(
      CONSOLE_LOG_PREFIX,
      'Update queue item',
      JSON.stringify(targetQueueItem),
      JSON.stringify(data)
    );

    targetQueueItem.text = data.text;
    targetQueueItem.words = this.sortWordsWithStatus(
      [...targetQueueItem.words, ...data.words],
      data.status
    );

    // Skip status update if targetQueueItem.status is end and data.status is in_progress
    if (
      targetQueueItem.status !== ETurnStatus.IN_PROGRESS &&
      data.status === ETurnStatus.IN_PROGRESS
    ) {
      return;
    }
    targetQueueItem.status = data.status;
  }

  _handleQueue() {
    const queueLength = this._queue.length;

    // Empty queue, skip
    if (queueLength === 0) {
      console.debug(CONSOLE_LOG_PREFIX, 'Queue is empty, skip');
      return;
    }

    const curPTS = this._pts;

    // Only one item, update chatHistory with queueItem
    if (queueLength === 1) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'Queue has only one item, update chatHistory',
        JSON.stringify(this._queue[0])
      );
      const queueItem = this._queue[0];
      this._handleTurnObj(queueItem, curPTS);
      this._mutateChatHistory();
      return;
    }

    if (queueLength > 2) {
      console.error(
        CONSOLE_LOG_PREFIX,
        'Queue length is greater than 2, but it should not happen'
      );
    }

    // Assume queueLength is 2
    if (queueLength > 1) {
      this._queue = this._queue.sort((a, b) => a.turn_id - b.turn_id);
      const nextItem = this._queue[this._queue.length - 1];
      const lastItem = this._queue[this._queue.length - 2];

      // Check if nextItem is started
      const firstWordOfNextItem = nextItem.words[0];

      // If firstWordOfNextItem.start_ms > curPTS, work on lastItem
      if (firstWordOfNextItem.start_ms > curPTS) {
        this._handleTurnObj(lastItem, curPTS);
        this._mutateChatHistory();
        return;
      }

      // If firstWordOfNextItem.start_ms <= curPTS, work on nextItem, assume lastItem is interrupted
      const lastItemCorrespondingChatHistoryItem = this.chatHistory.find(
        (item) =>
          item.turn_id === lastItem.turn_id &&
          item.stream_id === lastItem.stream_id
      );

      if (!lastItemCorrespondingChatHistoryItem) {
        console.warn(
          CONSOLE_LOG_PREFIX,
          'No corresponding chatHistory item found',
          lastItem
        );
        return;
      }

      lastItemCorrespondingChatHistoryItem.status = ETurnStatus.INTERRUPTED;
      this._lastPoppedQueueItem = this._queue.shift();

      // Handle nextItem
      this._handleTurnObj(nextItem, curPTS);
      this._mutateChatHistory();
      return;
    }
  }

  _interruptQueue(options) {
    const turn_id = options.turn_id;
    const start_ms = options.start_ms;
    const correspondingQueueItem = this._queue.find(
      (item) => item.turn_id === turn_id
    );

    if (!correspondingQueueItem) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'No corresponding queue item found',
        options
      );
      return;
    }

    // Update status to interrupted
    correspondingQueueItem.status = ETurnStatus.INTERRUPTED;

    // Split words into two parts
    const leftWords = correspondingQueueItem.words.filter(
      (word) => word.start_ms <= start_ms
    );
    const rightWords = correspondingQueueItem.words.filter(
      (word) => word.start_ms > start_ms
    );

    const isLeftWordsEmpty = leftWords.length === 0;

    if (isLeftWordsEmpty) {
      // Set all words to interrupted
      correspondingQueueItem.words.forEach((word) => {
        word.word_status = ETurnStatus.INTERRUPTED;
      });
    } else {
      // Set last left word to interrupted
      leftWords[leftWords.length - 1].word_status = ETurnStatus.INTERRUPTED;
      // Set all right words to interrupted
      rightWords.forEach((word) => {
        word.word_status = ETurnStatus.INTERRUPTED;
      });
      // Update words
      correspondingQueueItem.words = [...leftWords, ...rightWords];
    }
  }

  _handleTurnObj(queueItem, curPTS) {
    let correspondingChatHistoryItem = this.chatHistory.find(
      (item) =>
        item.turn_id === queueItem.turn_id &&
        item.stream_id === queueItem.stream_id
    );

    console.debug(
      CONSOLE_LOG_PREFIX,
      '_handleTurnObj',
      this._pts,
      JSON.stringify(queueItem),
      JSON.stringify(queueItem.words),
      'correspondingChatHistoryItem',
      JSON.stringify(correspondingChatHistoryItem)
    );

    if (!correspondingChatHistoryItem) {
      console.debug(
        CONSOLE_LOG_PREFIX,
        'No corresponding chatHistory item found',
        'push to chatHistory'
      );
      correspondingChatHistoryItem = {
        turn_id: queueItem.turn_id,
        uid: `${queueItem.uid}`,
        stream_id: queueItem.stream_id,
        _time: new Date().getTime(),
        text: '',
        status: queueItem.status,
        metadata: queueItem
      };
      this._appendChatHistory(correspondingChatHistoryItem);
    }

    // Update time for auto-scroll
    correspondingChatHistoryItem._time = new Date().getTime();
    correspondingChatHistoryItem.metadata = queueItem;

    // Update status if interrupted
    if (queueItem.status === ETurnStatus.INTERRUPTED) {
      correspondingChatHistoryItem.status = ETurnStatus.INTERRUPTED;
    }

    // Pop all valid word items (word.start_ms <= curPTS)
    const validWords = [];
    const restWords = [];

    for (const word of queueItem.words) {
      if (word.start_ms <= curPTS) {
        validWords.push(word);
      } else {
        restWords.push(word);
      }
    }

    const isRestWordsEmpty = restWords.length === 0;
    const isLastWordFinal =
      validWords[validWords.length - 1]?.word_status !== ETurnStatus.IN_PROGRESS;

    // If restWords is empty and last word is final, this turn is ended
    if (isRestWordsEmpty && isLastWordFinal) {
      correspondingChatHistoryItem.text = queueItem.text;
      correspondingChatHistoryItem.status = queueItem.status;
      this._lastPoppedQueueItem = this._queue.shift();
      return;
    }

    // If restWords is not empty, update text with valid words
    const validWordsText = validWords
      .filter((word) => word.word_status === ETurnStatus.IN_PROGRESS)
      .map((word) => word.word)
      .join('');
    correspondingChatHistoryItem.text = validWordsText;

    // If last word is interrupted, this turn is ended
    const isLastWordInterrupted =
      validWords[validWords.length - 1]?.word_status === ETurnStatus.INTERRUPTED;
    if (isLastWordInterrupted) {
      this._lastPoppedQueueItem = this._queue.shift();
      return;
    }
  }

  _appendChatHistory(item) {
    // If turn_id is 0, append to front (greeting message)
    if (item.turn_id === 0) {
      this.chatHistory = [item, ...this.chatHistory];
    } else {
      this.chatHistory.push(item);
    }
  }

  _mutateChatHistory() {
    console.debug(
      CONSOLE_LOG_PREFIX,
      'Mutate chatHistory',
      this._pts,
      this.chatHistory
        .map((item) => `[uid:${item.uid}] ${item.text}[status: ${item.status}]`)
        .join('\n')
    );
    this.onChatHistoryUpdated?.(this.chatHistory);
  }
}

/**
 * Simple EventHelper for event-based communication
 */
class EventHelper {
  constructor() {
    this._listeners = {};
  }

  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((cb) => cb !== callback);
  }

  emit(event, ...args) {
    if (!this._listeners[event]) return;
    this._listeners[event].forEach((callback) => callback(...args));
  }

  clear() {
    this._listeners = {};
  }
}

/**
 * LegacyMessageHelper - Singleton wrapper with event-based interface
 */
class LegacyMessageHelper extends EventHelper {
  static _instance = null;

  static getInstance() {
    if (!LegacyMessageHelper._instance) {
      LegacyMessageHelper._instance = new LegacyMessageHelper();
    }
    return LegacyMessageHelper._instance;
  }

  constructor() {
    super();
    console.info(CONSOLE_LOG_PREFIX, 'LegacyMessageHelper instance created');

    this.messageService = new MessageServiceV2({
      onAgentStateChange: (state) => {
        console.debug(CONSOLE_LOG_PREFIX, 'onAgentStateChange', state);
        this.emit('agent-state-changed', state);
      },
      onChatHistoryUpdated: (chatHistory) => {
        console.debug(CONSOLE_LOG_PREFIX, 'onChatHistoryUpdated', chatHistory);
        this.emit('transcript-updated', chatHistory);
      }
    });
  }
}

/**
 * TranscriptManager - Wrapper class for easy integration
 * Bridges the official Agora implementation with the UI
 */
class TranscriptManager {
  constructor(animeCompanion) {
    this.companion = animeCompanion;
    this.transcriptHistory = [];

    console.log('[TranscriptManager] Initializing with MessageServiceV2');

    // Create message service
    this.messageService = new MessageServiceV2({
      onChatHistoryUpdated: (chatHistory) => {
        console.log('[TranscriptManager] Chat history updated:', chatHistory);
        this.handleChatHistoryUpdate(chatHistory);
      },
      onAgentStateChange: (state) => {
        console.log('[TranscriptManager] Agent state changed:', state);
        this.handleAgentStateChange(state);
      }
    });

    // Start the service
    this.messageService.run();

    // Set up PTS (presentation timestamp) auto-increment
    // This ensures word-level messages are processed in a timely manner
    this.ptsInterval = setInterval(() => {
      const currentPTS = Date.now();
      this.messageService.setPts(currentPTS);
    }, 100); // Update PTS every 100ms

    console.log('[TranscriptManager] Initialized successfully');
  }

  /**
   * Handle incoming stream messages from Agora
   */
  handleStreamMessage(uid, payload) {
    console.log('[TranscriptManager] Received stream message from UID:', uid);

    // // Log raw payload for debugging
    // const decoder = new TextDecoder();
    // const rawChunk = decoder.decode(payload);
    // console.log('[TranscriptManager] Raw chunk (first 200 chars):', rawChunk.substring(0, 200));

    try {
      // Pass to message service for processing
      this.messageService.handleStreamMessage(uid, payload);
    } catch (error) {
      console.error('[TranscriptManager] Error handling stream message:', error);
      this.addTranscriptMessage('System', `Error: ${error.message}`, 'system');
    }
  }

  /**
   * Handle chat history updates from MessageServiceV2
   */
  handleChatHistoryUpdate(chatHistory) {
    console.log('[TranscriptManager] Chat history update received, total items:', chatHistory.length);

    // Process each item in chat history
    chatHistory.forEach((item, index) => {
      console.log(`[TranscriptManager] Processing item ${index}:`, {
        turn_id: item.turn_id,
        stream_id: item.stream_id,
        status: item.status,
        text_preview: item.text?.substring(0, 50),
        metadata_object: item.metadata?.object,
        uid: item.uid
      });

      // Skip empty messages
      if (!item.text || !item.text.trim()) {
        console.log('[TranscriptManager] Skipping empty message');
        return;
      }

      // Create unique key for this message
      const messageKey = `${item.turn_id}_${item.stream_id}`;

      // Check if we've already displayed this message
      const existingMessage = this.transcriptHistory.find(
        (msg) => msg.messageKey === messageKey
      );

      // Determine speaker from metadata object field
      let speaker = 'AI Companion';
      let type = 'agent';

      if (item.metadata) {
        const objectType = item.metadata.object;
        console.log('[TranscriptManager] Message object type:', objectType);

        if (objectType === ETranscriptionObjectType.USER_TRANSCRIPTION) {
          speaker = 'You';
          type = 'user';
        } else if (objectType === ETranscriptionObjectType.AGENT_TRANSCRIPTION) {
          speaker = 'AI Companion';
          type = 'agent';
        }
      } else {
        // Fallback: use stream_id (0 = agent, non-zero = user)
        console.log('[TranscriptManager] No metadata, using stream_id:', item.stream_id);
        const isUser = item.stream_id !== 0;
        speaker = isUser ? 'You' : 'AI Companion';
        type = isUser ? 'user' : 'agent';
      }

      console.log('[TranscriptManager] Determined speaker:', speaker, 'type:', type, 'status:', item.status);

      if (!existingMessage) {
        // New message - create DOM element and add to history
        const messageElement = this.createTranscriptMessage(speaker, item.text.trim(), type);

        this.transcriptHistory.push({
          messageKey,
          turn_id: item.turn_id,
          stream_id: item.stream_id,
          uid: item.uid,
          text: item.text,
          status: item.status,
          _time: item._time,
          element: messageElement, // Store DOM reference
          displayed: true
        });

        console.log('[TranscriptManager] ✅ Displaying NEW message:', speaker, '-', item.text);
      } else {
        // Message exists - update it in place if text changed
        if (existingMessage.text !== item.text || existingMessage.status !== item.status) {
          console.log('[TranscriptManager] 🔄 Updating message in place:', {
            from: existingMessage.text,
            to: item.text,
            status: item.status
          });

          existingMessage.text = item.text;
          existingMessage.status = item.status;
          existingMessage._time = item._time;

          // Update the DOM element in place
          if (existingMessage.element) {
            this.updateTranscriptMessage(existingMessage.element, item.text.trim(), item.status);
          }
        } else {
          // Message unchanged, skip
          console.log('[TranscriptManager] Message unchanged, skipping:', messageKey);
        }
      }
    });
  }

  /**
   * Handle agent state changes
   */
  handleAgentStateChange(state) {
    if (!this.companion || !this.companion.elements) return;

    const stateLabels = {
      'idle': '💤 Idle',
      'listening': '👂 Listening',
      'thinking': '🤔 Thinking...',
      'speaking': '🗣️ Speaking',
      'silent': '🤫 Silent'
    };

    const label = stateLabels[state.state] || state.state;

    // Update status text to include agent state
    if (this.companion.elements.statusText) {
      const currentStatus = this.companion.elements.statusText.textContent;
      // Only update if we're connected
      if (currentStatus.includes('Connected')) {
        const baseName = currentStatus.split(' - ')[0];
        this.companion.elements.statusText.textContent = `${baseName} - ${label}`;
      }
    }
  }

  /**
   * Create a transcript message DOM element
   * @returns {HTMLElement} The created message element
   */
  createTranscriptMessage(speaker, message, type = 'final') {
    if (!message || !message.trim()) return null;

    const transcriptMessages = this.companion?.elements?.transcriptMessages;
    if (!transcriptMessages) return null;

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

    return messageElement;
  }

  /**
   * Update an existing transcript message in place
   */
  updateTranscriptMessage(messageElement, newText, status) {
    if (!messageElement) return;

    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.textContent = newText;

      // Add visual indicator for in-progress messages
      if (status === ETurnStatus.IN_PROGRESS) {
        contentDiv.style.opacity = '0.7';
      } else {
        contentDiv.style.opacity = '1';
      }
    }

    // Auto-scroll to bottom when updating
    const transcriptMessages = this.companion?.elements?.transcriptMessages;
    if (transcriptMessages) {
      transcriptMessages.scrollTop = transcriptMessages.scrollHeight;
    }
  }

  /**
   * Add message to transcript UI (legacy compatibility)
   */
  addTranscriptMessage(speaker, message, type = 'final') {
    if (!message || !message.trim()) return;

    // Update UI through companion
    if (this.companion && this.companion.addChatMessage) {
      this.companion.addChatMessage(speaker, message, type);
    }
  }

  /**
   * Send message to AI via Agora datastream
   */
  async sendMessageToAI(message) {
    if (!this.companion || !this.companion.client) {
      console.error('[TranscriptManager] No Agora client available');
      return false;
    }

    try {
      // Create user message - just send as plain text for now
      // The AI agent should receive this via datastream
      const messageData = {
        type: 'text',
        text: message,
        timestamp: Date.now()
      };

      // Convert to Uint8Array
      const encoder = new TextEncoder();
      const messageBuffer = encoder.encode(JSON.stringify(messageData));

      // Send via Agora datastream
      await this.companion.client.sendStreamMessage(messageBuffer);

      // Add to local transcript immediately
      this.addTranscriptMessage('You', message, 'user');

      console.log('[TranscriptManager] Message sent to AI:', message);
      return true;
    } catch (error) {
      console.error('[TranscriptManager] Failed to send message:', error);
      this.addTranscriptMessage('System', `Failed to send: ${error.message}`, 'system');
      return false;
    }
  }

  /**
   * Clear transcript
   */
  clearTranscript() {
    this.transcriptHistory = [];

    // Clear PTS interval
    if (this.ptsInterval) {
      clearInterval(this.ptsInterval);
    }

    if (this.messageService) {
      this.messageService.cleanup();

      // Restart the service
      this.messageService = new MessageServiceV2({
        onChatHistoryUpdated: (chatHistory) => {
          this.handleChatHistoryUpdate(chatHistory);
        },
        onAgentStateChange: (state) => {
          this.handleAgentStateChange(state);
        }
      });
      this.messageService.run();

      // Restart PTS interval
      this.ptsInterval = setInterval(() => {
        const currentPTS = Date.now();
        this.messageService.setPts(currentPTS);
      }, 100);
    }
    console.log('[TranscriptManager] Transcript cleared');
  }

  /**
   * Update presentation timestamp for word-level sync
   */
  updatePTS(pts) {
    if (this.messageService) {
      this.messageService.setPts(pts);
    }
  }

  /**
   * Get transcript history
   */
  getTranscriptHistory() {
    return this.transcriptHistory;
  }

  /**
   * Cleanup on destroy
   */
  destroy() {
    if (this.ptsInterval) {
      clearInterval(this.ptsInterval);
      this.ptsInterval = null;
    }
    if (this.messageService) {
      this.messageService.cleanup();
    }
    this.transcriptHistory = [];
  }
}

// Export for use in main application
if (typeof window !== 'undefined') {
  window.MessageService = MessageService;
  window.MessageServiceV2 = MessageServiceV2;
  window.LegacyMessageHelper = LegacyMessageHelper;
  window.TranscriptManager = TranscriptManager; // Export the wrapper
  window.TranscriptEnums = {
    ETurnStatus,
    ETranscriptionObjectType,
    EAgentState,
    EMessageServiceMode
  };
}

// Also support module exports if needed
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MessageService,
    MessageServiceV2,
    LegacyMessageHelper,
    TranscriptManager,
    ETurnStatus,
    ETranscriptionObjectType,
    EAgentState,
    EMessageServiceMode
  };
}
