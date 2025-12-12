const express = require('express');
const router = express.Router();
const { getChannelInfo, startConversation, stopConversation } = require('./agoraController.js');

router.get('/channel-info', getChannelInfo);
router.post('/start', startConversation);
router.post('/stop/:agentId', stopConversation);

module.exports = router;