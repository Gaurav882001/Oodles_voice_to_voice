import React, { useState, useRef } from 'react';
import { Square, ChevronDown } from 'lucide-react';

const HindiTTSApp = () => {
  const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Oodles technologies');
  const [transcriptionText, setTranscriptionText] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const [textInput, setTextInput] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('Hindi');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(new Audio());
  const processingControllerRef = useRef(null);
  const streamRef = useRef(null);

  const languages = ['Hindi', 'English'];

  const cleanup = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    
    if (processingControllerRef.current) {
      processingControllerRef.current.abort();
      processingControllerRef.current = null;
    }
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const startRecording = async () => {
    try {
      cleanup();
      
      setIsProcessing(false);
      setTranscriptionText('');
      setStatus('Starting recording...');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        console.log('Recording stopped, processing audio...');
        try {
          if (audioChunksRef.current.length === 0) {
            throw new Error('No audio data recorded');
          }
          
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          if (audioBlob.size === 0) {
            throw new Error('Empty audio blob recorded');
          }
          
          console.log('Audio blob size:', audioBlob.size);
          await processAudio(audioBlob);
        } catch (err) {
          console.error('Error in onstop handler:', err);
          setStatus('Error processing audio: ' + err.message);
          setIsProcessing(false);
        }
      };

      mediaRecorderRef.current.onerror = (err) => {
        console.error('MediaRecorder error:', err);
        setStatus('Recording error occurred');
        setIsRecording(false);
        setIsProcessing(false);
        cleanup();
      };

      mediaRecorderRef.current.onstart = () => {
        console.log('Recording started successfully');
        setIsRecording(true);
        setStatus('Recording your query... Speak now!');
      };

      mediaRecorderRef.current.start(1000);
      
    } catch (err) {
      console.error('Error starting recording:', err);
      setStatus('Error accessing microphone. Please allow microphone access.');
      setIsRecording(false);
      setIsProcessing(false);
      cleanup();
    }
  };

  const stopRecording = () => {
    console.log('Stop recording called');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      setIsRecording(false);
      setIsProcessing(true);
      setStatus('Processing your query...');
      mediaRecorderRef.current.stop();
    } else {
      console.log('MediaRecorder state:', mediaRecorderRef.current?.state);
    }
  };

  const parseRetryAfter = (errorMessage) => {
    const match = errorMessage.match(/Please try again in (\d+h)?(\d+m)?(\d+\.\d+s)?/);
    if (!match) return null;
    let seconds = 0;
    if (match[1]) seconds += parseInt(match[1]) * 3600;
    if (match[2]) seconds += parseInt(match[2]) * 60;
    if (match[3]) seconds += parseFloat(match[3]);
    return seconds * 1000;
  };

  const processAudio = async (audioBlob, retryCount = 0, maxRetries = 3) => {
    processingControllerRef.current = new AbortController();
    console.log('Processing audio blob of size:', audioBlob.size);
    
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'user_input.webm');
      formData.append('language', selectedLanguage.toLowerCase());

      console.log('Sending transcription request...');
      const transcribeResponse = await fetch(`${API_URL}/transcribe`, {
        method: 'POST',
        body: formData,
        signal: processingControllerRef.current.signal,
      });
      
      if (!transcribeResponse.ok) {
        const errorData = await transcribeResponse.json();
        if (transcribeResponse.status === 401 || 
            (errorData.detail && errorData.detail.includes('invalid_api_key')) ||
            (errorData.detail && errorData.detail.includes('Incorrect API key'))) {
          throw new Error('Invalid API key');
        }
        throw new Error(`Transcription failed: ${errorData.detail || transcribeResponse.statusText}`);
      }
      
      const { transcription, language } = await transcribeResponse.json();
      console.log('Transcription received:', transcription, 'Language:', language);
      
      if (!transcription || !transcription.trim()) {
        throw new Error('No valid transcription received - please speak more clearly');
      }
      
      setTranscriptionText(transcription);
      setStatus(`You said: ${transcription}`);

      console.log('Chat History before request:', JSON.stringify(chatHistory));
      const aiResponse = await fetch(`${API_URL}/generate_response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: transcription, 
          chat_history: chatHistory,
          language: selectedLanguage.toLowerCase()
        }),
        signal: processingControllerRef.current.signal,
      });
      
      if (!aiResponse.ok) {
        const errorData = await aiResponse.json();
        if (aiResponse.status === 401 || 
            (errorData.detail && errorData.detail.includes('invalid_api_key')) ||
            (errorData.detail && errorData.detail.includes('Incorrect API key'))) {
          throw new Error('Invalid API key');
        }
        throw new Error(`AI response failed: ${errorData.detail || aiResponse.statusText}`);
      }
      
      const { response } = await aiResponse.json();
      console.log('AI Response:', response);

      setChatHistory(prev => {
        const updatedHistory = [...prev, { user: transcription, ai: response }];
        console.log('Updated Chat History:', JSON.stringify(updatedHistory));
        return updatedHistory;
      });
      setTranscriptionText('');

      try {
        const ttsResponse = await fetch(`${API_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: response, 
            language: selectedLanguage.toLowerCase()
          }),
          signal: processingControllerRef.current.signal,
        });
        
        if (!ttsResponse.ok) {
          const errorData = await ttsResponse.json();
          if (ttsResponse.status === 429 && retryCount < maxRetries) {
            const retryAfter = parseRetryAfter(errorData.detail) || 10000;
            console.log(`Rate limit reached. Retrying in ${retryAfter / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter));
            return processAudio(audioBlob, retryCount + 1, maxRetries);
          }
          if (ttsResponse.status === 401 || 
              (errorData.detail && errorData.detail.includes('invalid_api_key')) ||
              (errorData.detail && errorData.detail.includes('Incorrect API key'))) {
            throw new Error('Invalid API key');
          }
          throw new Error(`TTS generation failed: ${errorData.detail || ttsResponse.statusText}`);
        }
        
        const audioBlobTTS = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioBlobTTS);
        audioRef.current = new Audio(audioUrl);
        
        audioRef.current.oncanplaythrough = () => {
          audioRef.current.play().catch(err => {
            console.error('Audio playback error:', err);
            setStatus('AI response received (text only)');
          });
        };
        
        setStatus('AI is responding...');
      } catch (ttsError) {
        console.error('TTS Error:', ttsError);
        setStatus('AI response received (text only)');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Processing aborted due to new recording');
        setStatus('Click the square button to speak your query');
      } else {
        console.error('Error processing audio:', err);
        setStatus(`Error: ${err.message}`);
      }
    } finally {
      setIsProcessing(false);
      processingControllerRef.current = null;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    }
  };

  const toggleRecording = () => {
    console.log('Toggle recording - current state:', { isRecording, isProcessing });
    
    if (isRecording) {
      stopRecording();
    } else if (!isProcessing) {
      startRecording();
    }
  };

  const sendTextMessage = async () => {
    if (!textInput.trim() || isProcessing) return;
    
    const messageText = textInput.trim();
    setTextInput('');
    setIsProcessing(true);
    setStatus('Processing your message...');

    try {
      console.log('Chat History before request:', JSON.stringify(chatHistory));
      const aiResponse = await fetch(`${API_URL}/generate_response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: messageText, 
          chat_history: chatHistory,
          language: selectedLanguage.toLowerCase()
        }),
      });
      
      if (!aiResponse.ok) {
        const errorData = await aiResponse.json();
        if (aiResponse.status === 401 || 
            (errorData.detail && errorData.detail.includes('invalid_api_key')) ||
            (errorData.detail && errorData.detail.includes('Incorrect API key'))) {
          throw new Error('Invalid API key');
        }
        throw new Error(`AI response failed: ${errorData.detail || aiResponse.statusText}`);
      }
      
      const { response } = await aiResponse.json();
      console.log('AI Response:', response);

      setChatHistory(prev => {
        const updatedHistory = [...prev, { user: messageText, ai: response }];
        console.log('Updated Chat History:', JSON.stringify(updatedHistory));
        return updatedHistory;
      });

      try {
        const ttsResponse = await fetch(`${API_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: response, 
            language: selectedLanguage.toLowerCase()
          }),
        });
        
        if (ttsResponse.ok) {
          const audioBlobTTS = await ttsResponse.blob();
          const audioUrl = URL.createObjectURL(audioBlobTTS);
          audioRef.current = new Audio(audioUrl);
          audioRef.current.play().catch(err => {
            console.error('Audio playback error:', err);
            setStatus('AI response received');
          });
          setStatus('AI is responding...');
        } else {
          setStatus('AI response received');
        }
      } catch (ttsError) {
        console.error('TTS Error:', ttsError);
        setStatus('AI response received');
      }
    } catch (err) {
      console.error('Error processing message:', err);
      setStatus(`Error processing message: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTextMessage();
    }
  };

  const handleLanguageSelect = (language) => {
    setSelectedLanguage(language);
    setIsDropdownOpen(false);
  };

  return (
    <div className="min-h-screen bg-white p-2">
      <style jsx>{`
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .markdown-content h1, .markdown-content h2, .markdown-content h3 {
          color: #ffffff;
          font-weight: bold;
          margin-bottom: 0.5rem;
        }
        .markdown-content p {
          color: #d1d5db;
          margin-bottom: 0.5rem;
        }
        .markdown-content ul, .markdown-content ol {
          color: #d1d5db;
          margin-left: 1.5rem;
          margin-bottom: 0.5rem;
        }
        .markdown-content li {
          margin-bottom: 0.25rem;
        }
        .markdown-content strong {
          color: #ffffff;
        }
        .markdown-content a {
          color: #60a5fa;
          text-decoration: underline;
        }
        .markdown-content code {
          background-color: #1f2937;
          padding: 0.2rem 0.4rem;
          border-radius: 0.25rem;
          color: #f3f4f6;
        }
        .markdown-content pre {
          background-color: #1f2937;
          padding: 1rem;
          border-radius: 0.5rem;
          overflow-x: auto;
        }
        .user-message {
          background-color: #374151;
          border-radius: 0.5rem 0.5rem 0 0.5rem;
          padding: 0.75rem;
          margin-bottom: 0.5rem;
          margin-left: 1rem;
          max-width: 80%;
          align-self: flex-end;
          color: #ffffff;
        }
        .ai-message {
          background-color: #1f2937;
          border-radius: 0.5rem 0.5rem 0.5rem 0;
          padding: 0.75rem;
          margin-bottom: 0.5rem;
          margin-right: 1rem;
          max-width: 80%;
          align-self: flex-start;
          color: #d1d5db;
        }
      `}</style>

      {/* Header */}
      <div className="max-w-6xl mx-auto mb-8">
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center">
            <div> <img src="Logo.png" alt="" /></div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Panel - Description */}
        <div className="bg-slate-800 rounded-xl p-8">
          <h2 className="text-white text-2xl font-semibold mb-6">
            AI Voice Assistant
          </h2>
          
          <div className="text-gray-300 mb-6 leading-relaxed">
            This application provides a seamless voice-to-voice conversation experience with an AI assistant. Built using modern web technologies, it offers natural speech interaction with intelligent responses.
          </div>

          <h3 className="text-white text-xl font-semibold mb-4">Key Features:</h3>
          
          <ul className="text-gray-300 space-y-3 mb-6">
            <li className="flex items-start">
              <span className="text-yellow-400 mr-3 mt-1">•</span>
              <span>Real-time voice transcription</span>
            </li>
            <li className="flex items-start">
              <span className="text-yellow-400 mr-3 mt-1">•</span>
              <span>Natural voice responses</span>
            </li>
            <li className="flex items-start">
              <span className="text-yellow-400 mr-3 mt-1">•</span>
              <span>Dual input modes: voice recording and text typing</span>
            </li>
            <li className="flex items-start">
              <span className="text-yellow-400 mr-3 mt-1">•</span>
              <span>Multi-language support (Hindi & English)</span>
            </li>
          </ul>

          <p className="text-gray-300 leading-relaxed">
           Simply click the microphone button to start recording, or type your message directly. Select your preferred language from the dropdown. The AI will respond with both text and voice, creating a natural conversation flow.
          </p>
        </div>

        {/* Right Panel - Voice AI Agent */}
        <div className="bg-slate-800 rounded-xl p-8 relative overflow-hidden flex flex-col h-[600px]">
          {/* Gradient Background Effect */}
          <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-blue-500/20 via-blue-600/10 to-transparent pointer-events-none"></div>
          
          {/* Status Bar */}
          <div className="mb-6">
            <div className="flex items-center space-x-2 px-4 py-2 bg-gray-900/60 rounded-full">
              <div className={`w-2 h-2 rounded-full ${
                isRecording ? 'bg-red-400 animate-pulse' : 
                isProcessing ? 'bg-yellow-400 animate-pulse' : 
                'bg-green-400'
              }`}></div>
              <span className="text-white text-sm">{status}</span>
            </div>
          </div>

          {/* Chat History Display - Expanded */}
          <div className="flex-1 mb-4 bg-gray-900/40 rounded-lg p-4 overflow-y-auto scrollbar-hide relative">
            {/* Messages container */}
            <div className="flex flex-col space-y-2">
              {chatHistory.map((chat, index) => (
                <div key={index} className="flex flex-col space-y-2">
                  <div className="user-message">
                    <p>{chat.user}</p>
                  </div>
                  <div className="ai-message">
                    <div className="markdown-content">
                      <p>{chat.ai}</p>
                    </div>
                  </div>
                </div>
              ))}

              {transcriptionText && (
                <div className="user-message">
                  <p>{transcriptionText}</p>
                </div>
              )}
            </div>

            {/* Empty-state overlay (perfect center) */}
            {!chatHistory.length && !transcriptionText && (
              <div className="absolute inset-0 grid place-items-center pointer-events-none">
                <span className="text-gray-400 text-center">
                  Your conversation will appear here...
                </span>
              </div>
            )}
          </div>

          {/* Chat Input with Controls - Fixed at Bottom */}
          <div className="relative z-10 mt-auto">
            {/* Input Controls */}
            <div className="flex items-center space-x-2 bg-gray-900/60 rounded-lg p-2">
              {/* Microphone Toggle Button */}
              <button
                onClick={toggleRecording}
                disabled={isProcessing && !isRecording}
                className={`p-3 rounded-lg flex items-center justify-center transition-all duration-200 ${
                  isRecording 
                    ? 'bg-red-500 hover:bg-red-400 text-white' 
                    : isProcessing
                    ? 'bg-gray-600 cursor-not-allowed text-gray-400'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                }`}
                title={
                  isRecording ? 'Stop recording' : 
                  isProcessing ? 'Processing...' : 
                  'Start recording'
                }
              >
                {isRecording ? (
                  <Square size={20} className="fill-current" />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
                  </svg>
                )}
              </button>

              {/* Text Input with Send Button Inside */}
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Type your message..."
                  className="w-full bg-gray-800 text-white placeholder-gray-400 rounded-lg px-4 py-3 pr-12 border border-gray-600 focus:border-blue-500 focus:outline-none"
                  disabled={isRecording}
                />
                
                {/* Send Button Inside Input */}
                <button
                  onClick={sendTextMessage}
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isRecording || isProcessing || !textInput.trim()}
                  title="Send message"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>

              {/* Language Dropdown - Now on the right side */}
              <div className="relative">
                <button
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  className="px-3 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-all duration-200 flex items-center space-x-1 min-w-max"
                  disabled={isRecording || isProcessing}
                  title={`Current language: ${selectedLanguage}`}
                >
                  <span className="text-sm font-medium">{selectedLanguage}</span>
                  <ChevronDown size={16} className={`transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                
                {isDropdownOpen && (
                  <div className="absolute bottom-full right-0 mb-1 bg-gray-700 rounded-lg shadow-lg border border-gray-600 z-50 min-w-full">
                    {languages.map((language) => (
                      <button
                        key={language}
                        onClick={() => handleLanguageSelect(language)}
                        className={`w-full text-left px-4 py-2 text-sm transition-colors duration-200 first:rounded-t-lg last:rounded-b-lg whitespace-nowrap ${
                          selectedLanguage === language 
                            ? 'bg-blue-600 text-white' 
                            : 'text-gray-300 hover:bg-gray-600 hover:text-white'
                        }`}
                      >
                        {language}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HindiTTSApp;