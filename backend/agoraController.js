const axios = require('axios');

const getChannelInfo = (req, res) => {
  const { channel, uid } = req.query;
  
  if (!channel || !uid) {
    return res.status(400).json({ error: 'Channel and uid are required' });
  }

  try {
    res.json({ 
      appId: process.env.AGORA_APP_ID,
      channel,
      uid: parseInt(uid)
    });
  } catch (error) {
    console.error('Channel info error:', error);
    res.status(500).json({ error: 'Failed to get channel info' });
  }
};

const startConversation = async (req, res) => {
  try {
    const { channel, agentName, remoteUid } = req.body;
    
    if (!channel || !agentName || !remoteUid) {
      return res.status(400).json({ 
        error: 'Channel, agentName, and remoteUid are required' 
      });
    }

    const agentUid = Math.floor(Math.random() * 100000) + 1000;
    const avatarUid = Math.floor(Math.random() * 100000) + 2000;

    // Check if credentials are configured
    if (!process.env.AGORA_API_KEY || !process.env.AGORA_API_SECRET || !process.env.AGORA_APP_ID) {
      console.log('Agora credentials not configured, returning demo response');
      return res.json({
        success: true,
        agentId: `DEMO_AGENT_${Date.now()}`,
        agentUid: agentUid,
        avatarUid: avatarUid,
        channel: channel,
        demo: true,
        message: 'Demo mode - configure API credentials for full functionality'
      });
    }

    const requestBody = {
      name: agentName,
      properties: {
        channel: channel,
        token: "", // Empty token for testing, should generate proper token for production
        agent_rtc_uid: agentUid.toString(),
        remote_rtc_uids: [remoteUid.toString()],
        enable_string_uid: false,
        idle_timeout: 30,
        asr: {
          vendor: "ares",
          language: "en-US"
        },
        llm: {
          url: process.env.LLM_URL,
          api_key: process.env.LLM_API_KEY,
          system_messages: [
            {
              role: "system",
              content: process.env.LLM_SYSTEM_PROMPT || "You are a friendly AI anime girlfriend. Respond naturally in a caring, playful manner. Keep responses brief and conversational since this is voice-to-voice communication. Avoid long paragraphs and speak as if having a real conversation. Only output plain text responses, without any markdown, HTML tags, or emojis."
            }
          ],
          greeting_message: "Hi there! I'm your AI anime girlfriend. How can I make your day better?",
          failure_message: "Sorry, I'm having some trouble right now. Let me try again!",
          params: {
            model: process.env.LLM_MODEL || "gpt-4o-mini"
          },
          input_modalities: ["text"],
          output_modalities: ["text"]
        },
        tts: {
          vendor: process.env.TTS_VENDOR || "microsoft",
          params: {
            key: process.env.TTS_API_KEY,
            region: process.env.TTS_REGION || "japanwest",
            voice_name: process.env.TTS_VOICE || "zh-CN-XiaoxiaoMultilingualNeural",
            enable_words: false // send agent transcription even if tts fails
          },
          skipPatterns: [1, 2, 3, 4, 5, 6]
        },
        // tts: {
        //   vendor: "cartesia",
        //   params: {
        //     api_key: process.env.CARTESIA_API_KEY,
        //     model_id: "sonic-3",
        //     voice: { 
        //       mode: "id",
        //       id: process.env.CARTESIA_VOICE_ID
        //     },
        //     output_format: { 
        //       container: "raw",
        //       sample_rate: 16000
        //     },
        //     language: "en"
        //   }
        // },
        avatar: {
          vendor: "akool",
          enable: true,
          params: {
            api_key: process.env.AKOOL_API_KEY,
            quality: "medium",
            agora_uid: avatarUid.toString(), 
            avatar_id: process.env.AKOOL_AVATAR_ID || "dvp_Emma_agora"
          }
        },
        advanced_features: {
          enable_aivad: true,
          enable_bhvs: true,
          enable_rtm: true
        },
        parameters: {
          data_channel: "rtm",
          transcript: {
            redundant: false
          }
        }
      }
    };

    const auth = Buffer.from(`${process.env.AGORA_API_KEY}:${process.env.AGORA_API_SECRET}`).toString('base64');
    
    const response = await axios.post(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${process.env.AGORA_APP_ID}/join`,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`
        }
      }
    );

    res.json({
      success: true,
      agentId: response.data.agent_id,
      agentUid: agentUid,
      avatarUid: avatarUid,
      channel: channel
    });

  } catch (error) {
    console.error('Agora API error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to start conversation',
      details: error.response?.data || error.message
    });
  }
};

const stopConversation = async (req, res) => {
  try {
    const { agentId } = req.params;
    
    if (!agentId) {
      return res.status(400).json({ error: 'Agent ID is required' });
    }

    // Check if credentials are configured
    if (!process.env.AGORA_API_KEY || !process.env.AGORA_API_SECRET || !process.env.AGORA_APP_ID) {
      console.log('Agora credentials not configured, simulating stop conversation');
      return res.json({ 
        success: true, 
        message: 'Conversation stopped (demo mode - no API credentials)',
        demo: true
      });
    }

    const auth = Buffer.from(`${process.env.AGORA_API_KEY}:${process.env.AGORA_API_SECRET}`).toString('base64');
    
    const response = await axios.post(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${process.env.AGORA_APP_ID}/agents/${agentId}/leave`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`
        }
      }
    );

    res.json({ success: true, message: 'Conversation stopped' });

  } catch (error) {
    console.error('Stop conversation error:', error.response?.data || error.message);
    
    // Return success in demo mode to avoid blocking UI
    res.json({ 
      success: true, 
      message: 'Conversation stopped (demo mode - API error handled)',
      error: error.response?.data || error.message,
      demo: true
    });
  }
};

module.exports = {
  getChannelInfo,
  startConversation,
  stopConversation
};