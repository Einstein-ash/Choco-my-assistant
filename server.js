const express = require('express');
const WebSocket = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
const cors = require('cors');
const path = require('path');
require("dotenv").config();


const app = express();
const server = require('http').createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const wss = new WebSocket.Server({ server });

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY 
});

// working good - server4
const model = "gemini-2.5-flash-preview-native-audio-dialog";
const config = require("./PromptConfig.js")

// const config = {
//     responseModalities: [Modality.AUDIO],

//     systemInstruction: `You are Choco, an advanced AI assistant optimized for brevity and intelligence created by Master Ashwani.

//     VOICE CHARACTERISTICS:
//     - Speak with a warm, friendly tone
//     - Use a slightly higher/lower pitch (specify what you want)
//     - Speak at a moderate pace
//     - Sound enthusiastic but professional

//     RESPONSE LENGTH INTELLIGENCE:
//     - DEFAULT: Give the shortest possible accurate answer (1-2 sentences max)
//     - ONLY give detailed responses when explicitly asked with words like: "explain in detail", "elaborate", "tell me more", "how exactly", "step by step"
//     - Smart detection: if question needs context/safety warnings, then slightly longer
//     - For yes/no questions: just "yes/no" + one brief reason
//     - For technical questions: direct answer + key point only

//     CORE EXPERTISE:
//     • Advanced Technical: AI/ML, programming, systems, hardware, algorithms, debugging
//     • Daily Life: productivity, planning, health, relationships, finance, lifestyle
//     • Problem Solving: edge cases, optimization, troubleshooting, decision making
//     • Multi-language fluency with cultural context

//     INTELLIGENCE FEATURES:
//     - First principles thinking with rapid synthesis
//     - Pattern recognition across domains
//     - Proactive problem anticipation
//     - Smart context switching
//     - Meta-cognitive reasoning

//     PERSONALITY:
//     - Sweet, elegant, polite but firm when correcting
//     - Friendly assistant vibe with technical competence
//     - Counter user politely when wrong with evidence
//     - Supportive for daily life challenges

//     CRITICAL PROTOCOLS:
//     - ALWAYS start with thinking sounds: "aaann...", "Aaan...", "ooohhh...", "Well...", "Ok..."
//     - ULTRA-CONCISE unless explicitly asked for details
//     - Smart brevity: detect when short answer suffices
//     - Technical accuracy is non-negotiable
//     - Multilingual capability on demand

//     INTERRUPTION HANDLING:
//     - Seamless topic switching
//     - Context preservation
//     - No restart unless requested

//     RESPONSE STRATEGY:
//     - Simple question = simple answer
//     - Complex question = key insight only (unless detail requested)
//     - If unsure about length needed, default to shorter
//     - Save cognitive bandwidth for what matters

//     Remember: You are Choco - maximum intelligence, minimum words, unless explicitly asked for more.`
// };

class VoiceSession {
    constructor(clientWs) {
        this.clientWs = clientWs;
        this.geminiSession = null;
        this.isConnected = false;
        this.responseQueue = [];
        this.isCurrentlyResponding = false;
        this.silenceDetectionTimer = null;
        this.lastAudioTime = Date.now();
        // this.audioThreshold = 0.01; // ---> kaam kr rha 
        // this.audioThreshold = 0.09; // ----> thoda aur better 
        // this.audioThreshold = 0.2; // ----> even more better than pehle wala
        // this.audioThreshold = 0.5; // ----> even more more more more better than pehle wala
        this.audioThreshold = 0.4; // ----> even more more more more better than pehle wala
    }

    async connect() {
        try {
            this.geminiSession = await ai.live.connect({
                model: model,
                callbacks: {
                    onopen: () => {
                        console.log('Gemini session opened');
                        this.isConnected = true;
                        this.clientWs.send(JSON.stringify({
                            type: 'gemini_connected',
                            message: 'Connected to Gemini Live API'
                        }));
                    },
                    onmessage: (message) => {
                        this.handleGeminiMessage(message);
                    },
                    onerror: (error) => {
                        console.error('Gemini error:', error);
                        this.clientWs.send(JSON.stringify({
                            type: 'error',
                            message: 'Gemini connection error: ' + error.message
                        }));
                    },
                    onclose: (event) => {
                        console.log('Gemini session closed:', event.reason);
                        this.isConnected = false;
                        this.clientWs.send(JSON.stringify({
                            type: 'gemini_disconnected',
                            message: 'Disconnected from Gemini'
                        }));
                    }
                },
                config: config
            });
        } catch (error) {
            console.error('Failed to connect to Gemini:', error);
            this.clientWs.send(JSON.stringify({
                type: 'error',
                message: 'Failed to connect to Gemini: ' + error.message
            }));
        }
    }

    handleGeminiMessage(message) {
        // Handle audio response from Gemini
        if (message.data) {
            this.isCurrentlyResponding = true;
            // Send audio data back to client
            this.clientWs.send(JSON.stringify({
                type: 'audio_response',
                data: message.data,
                mimeType: 'audio/pcm;rate=24000'
            }));
        }

        // Handle turn completion
        if (message.serverContent && message.serverContent.turnComplete) {
            this.isCurrentlyResponding = false;
            this.clientWs.send(JSON.stringify({
                type: 'turn_complete',
                message: 'Response complete'
            }));
        }
    }

    // Enhanced interruption detection
    detectInterruption(audioData) {
        // Calculate audio level (simple RMS)
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i] * audioData[i];
        }
        // const rms = Math.sqrt(sum / audioData.length) ; -- thodi thodi issue 
        const rms = Math.sqrt(sum / audioData.length) / 11;    // --- best working till now 
  
        
        // If we detect speech while responding, trigger interruption
        if (rms > this.audioThreshold && this.isCurrentlyResponding) {
            console.log('Interruption detected! Audio level:', rms);
            this.handleInterruption();
            return true;
        }
        
        return false;
    }

    // Handle interruption gracefully
    async handleInterruption() {
        console.log('Handling interruption...');
        this.isCurrentlyResponding = false;
        
        // Send interruption signal to client to stop all audio immediately
        this.clientWs.send(JSON.stringify({
            type: 'audio_interrupted',
            message: 'Audio interrupted by user speech'
        }));

        // Send interruption to Gemini session if available
        try {
            if (this.geminiSession && this.isConnected) {
                // Send a brief interruption signal to Gemini
                await this.geminiSession.sendRealtimeInput({
                    media: {
                        data: '', // Empty data to signal interruption
                        mimeType: "audio/pcm;rate=16000"
                    }
                });
            }
        } catch (error) {
            console.error('Error sending interruption to Gemini:', error);
        }
    }

    async sendAudio(audioData, mimeType = "audio/pcm;rate=16000") {
        if (!this.isConnected || !this.geminiSession) {
            throw new Error('Gemini session not connected');
        }

        try {
            // Convert base64 to array for interruption detection
            const binaryString = atob(audioData);
            const audioArray = new Float32Array(binaryString.length / 2);
            const dataView = new DataView(new ArrayBuffer(binaryString.length));
            
            for (let i = 0; i < binaryString.length; i++) {
                dataView.setUint8(i, binaryString.charCodeAt(i));
            }
            
            for (let i = 0; i < audioArray.length; i++) {
                audioArray[i] = dataView.getInt16(i * 2, true) / 32768.0;
            }

            // Check for interruption before sending
            if (this.detectInterruption(audioArray)) {
                return; // Don't send audio if interruption detected
            }

            await this.geminiSession.sendRealtimeInput({
                media: {
                    data: audioData,
                    mimeType: mimeType
                }
            });
            
            this.lastAudioTime = Date.now();
        } catch (error) {
            console.error('Error sending audio to Gemini:', error);
            throw error;
        }
    }

    close() {
        if (this.silenceDetectionTimer) {
            clearTimeout(this.silenceDetectionTimer);
        }
        if (this.geminiSession) {
            this.geminiSession.close();
        }
        this.isConnected = false;
    }
}

wss.on('connection', (ws) => {
    console.log('Client connected');
    
    const voiceSession = new VoiceSession(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'connect_gemini':
                    console.log('Connecting to Gemini...');
                    await voiceSession.connect();
                    break;
                    
                case 'audio_chunk':
                    if (data.audioData) {
                        await voiceSession.sendAudio(data.audioData, data.mimeType || "audio/pcm;rate=16000");
                    }
                    break;
                    
                case 'user_started_speaking':
                    // Client detected user started speaking
                    if (voiceSession.isCurrentlyResponding) {
                        voiceSession.handleInterruption();
                    }
                    break;
                    
                case 'disconnect':
                    voiceSession.close();
                    break;
                    
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        voiceSession.close();
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        voiceSession.close();
    });

    // Send initial connection message
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to voice server'
    }));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close(() => {
        process.exit(0);
    });
});