const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

const port = 5000;
app.use(cors());
// Load Google Translation API Key from environment variables
const GOOGLE_TRANSLATION_API_KEY = process.env.GOOGLE_TRANSLATION_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Retry logic for handling rate-limiting errors
const retryRequest = async (url, data, headers, retries = 3, delay = 1000) => {
    try {
        const response = await axios.post(url, data, { headers });
        return response;
    } catch (error) {
        if (error.response && error.response.status === 429 && retries > 0) {
            console.log(`Rate limit exceeded. Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return retryRequest(url, data, headers, retries - 1, delay * 2); // Exponential backoff
        }
        throw error;
    }
};

// Endpoint to detect language and translate text
app.post("/detect-and-translate", async (req, res) => {
    const { text, targetLanguage } = req.body;

    // Validate input
    if (!text || !targetLanguage) {
        return res.status(400).json({ error: "Both 'text' and 'targetLanguage' are required." });
    }

    try {
        // Step 1: Detect the language of the input text
        const detectUrl = `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATION_API_KEY}`;
        const detectResponse = await axios.post(detectUrl, { q: text });
        
        // Ensure the response contains the expected structure
        if (!detectResponse.data.data.detections || !detectResponse.data.data.detections[0][0].language) {
            return res.status(500).json({ error: 'Failed to detect language' });
        }

        const detectedLanguage = detectResponse.data.data.detections[0][0].language;

        // If detected language is the same as the target language, skip translation
        if (detectedLanguage === targetLanguage) {
            return res.json({
                detectedLanguage,
                translatedText: text, // No translation needed
                message: "The detected language is the same as the target language.",
            });
        }

        // Step 2: Translate the text to the target language
        const translateUrl = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATION_API_KEY}`;
        const translateResponse = await axios.post(translateUrl, {
            q: text,
            source: detectedLanguage,
            target: targetLanguage,
            format: "text",
        });

        // Ensure translation response is valid
        if (!translateResponse.data.data || !translateResponse.data.data.translations) {
            return res.status(500).json({ error: 'Translation failed' });
        }

        const translatedText = translateResponse.data.data.translations[0].translatedText;

        // Send response with detected language and translated text
        res.json({
            detectedLanguage,
            translatedText,
        });
    } catch (error) {
        // Handle errors from the API
        console.error("Error in translation or detection:", error.response?.data || error.message);
        res.status(500).json({
            error: "An error occurred during language detection or translation.",
            details: error.response?.data || error.message,
        });
    }
});

// Store rooms and connected users
const rooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('join-room', ({ roomId }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = [];
        }
        rooms[roomId].push(socket.id);

        socket.join(roomId);
        console.log(`${socket.id} joined room ${roomId}`);

        // Notify other users in the room
        socket.to(roomId).emit('user-connected', socket.id);

        socket.on('disconnect', () => {
            rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
            socket.to(roomId).emit('user-disconnected', socket.id);
            if (rooms[roomId].length === 0) delete rooms[roomId];
            console.log(`${socket.id} disconnected from room ${roomId}`);
        });

        // Forward WebRTC signals
        socket.on('signal', (data) => {
            io.to(data.target).emit('signal', {
                sender: socket.id,
                signal: data.signal,
            });
        });
    });
});

// Endpoint to summarize the conversation using OpenAI
app.post("/summarize-conversation", async (req, res) => {
    const { conversationText } = req.body;

    const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
    };

    const data = {
        model: "gpt-3.5-turbo", // Or gpt-4 based on your plan
        messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: conversationText }
        ],
        max_tokens: 150,
    };

    try {
        const response = await retryRequest(
            "https://api.openai.com/v1/chat/completions",
            data,
            headers
        );

        res.json({ summary: response.data.choices[0].message.content.trim() });
    } catch (error) {
        console.error("Error summarizing conversation:", error);
        res.status(500).json({ error: "Failed to summarize conversation" });
    }
});

server.listen(3001, () => console.log('Socket server running on port 3001'));
app.listen(port, () => console.log(`API server running on http://localhost:${port}`));
