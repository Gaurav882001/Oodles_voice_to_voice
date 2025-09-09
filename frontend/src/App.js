import React, { useState, useRef, useCallback } from 'react';
import { Square, ChevronDown, Upload, File, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

const HindiTTSApp = () => {
  const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8001';
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Oodles technologies');
  const [transcriptionText, setTranscriptionText] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const [textInput, setTextInput] = useState('');
  // const [selectedLanguage, setSelectedLanguage] = useState('Hindi');
  const [selectedLanguage, setSelectedLanguage] = useState('English');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [documentFiles, setDocumentFiles] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [documentUploading, setDocumentUploading] = useState(false);
  const [documentMode, setDocumentMode] = useState(false);
  const [showFileUploadModal, setShowFileUploadModal] = useState(false);
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(new Audio());
  const processingControllerRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  const languages = ['Hindi', 'English', 'Arabic'];

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

  // Helper function to get relevant chat history based on current mode
  const getRelevantChatHistory = () => {
    if (documentMode) {
      // In document mode, return only entries with 'document' responses
      return chatHistory.filter(chat => "document" in chat);
    } else {
      // In regular mode, return only entries with 'ai' responses
      return chatHistory.filter(chat => "ai" in chat);
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
        throw new Error(`Transcription failed`);
      }
      
      const { transcription, language } = await transcribeResponse.json();
      console.log('Transcription received:', transcription, 'Language:', language);
      
      if (!transcription || !transcription.trim()) {
        throw new Error('No valid transcription received - please speak more clearly');
      }
      
      setTranscriptionText(transcription);
      setStatus(`You said: ${transcription}`);

      // Get relevant chat history based on current mode
      const relevantHistory = getRelevantChatHistory();
      console.log('Relevant Chat History before request:', JSON.stringify(relevantHistory));
      
      // If in document mode, use document query endpoint
      if (documentMode && documents && documents.length > 0) {
        await sendDocumentQuery(transcription);
        return;
      }
      
      const aiResponse = await fetch(`${API_URL}/generate_response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: transcription, 
          chat_history: relevantHistory,
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
        throw new Error(`AI response failed.`);
      }
      
      const { response } = await aiResponse.json();
      console.log('AI Response:', response);

      setChatHistory(prev => {
        const updatedHistory = [...prev, { user: transcription, ai: response }];
        console.log('Updated Chat History:', JSON.stringify(updatedHistory));
        return updatedHistory;
      });
      // Clear any lingering transcription text
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
          throw new Error(`TTS generation failed.`);
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
      // If in document mode, use document query endpoint
      if (documentMode && documents && documents.length > 0) {
        await sendDocumentQuery(messageText);
        return;
      }
      
      // Get relevant chat history based on current mode
      const relevantHistory = getRelevantChatHistory();
      console.log('Relevant Chat History before request:', JSON.stringify(relevantHistory));
      
      const aiResponse = await fetch(`${API_URL}/generate_response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: messageText, 
          chat_history: relevantHistory,
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
        throw new Error(`AI response failed.`);
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
  
  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      const maxSize = 50 * 1024 * 1024; // 50MB per file
      const maxFiles = 10; // Maximum 10 files
      
      if (files.length > maxFiles) {
        setStatus(`Too many files selected. Please select up to ${maxFiles} files.`);
        return;
      }
      
      const supportedExtensions = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif', 'webp', 'txt'];
      const validFiles = [];
      const invalidFiles = [];
      
      for (const file of files) {
        if (file.size > maxSize) {
          invalidFiles.push(`${file.name} (too large)`);
          continue;
        }
        
        const fileExtension = file.name.split('.').pop().toLowerCase();
        if (!supportedExtensions.includes(fileExtension)) {
          invalidFiles.push(`${file.name} (unsupported type)`);
          continue;
        }
        
        validFiles.push(file);
      }
      
      if (invalidFiles.length > 0) {
        setStatus(`Some files were rejected: ${invalidFiles.join(', ')}`);
      }
      
      if (validFiles.length === 0) {
        setStatus('No valid files selected. Please select supported file types (PDF, Word, Images, Text).');
        return;
      }
      
      setDocumentFiles(validFiles);
      const totalSize = validFiles.reduce((sum, file) => sum + file.size, 0);
      
      if (validFiles.length === 1) {
        setStatus(`Selected: ${validFiles[0].name} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
      } else {
        setStatus(`Selected ${validFiles.length} files (${(totalSize / 1024 / 1024).toFixed(2)} MB total)`);
      }
    }
  };
  
  const handleFileUpload = async () => {
    if (!documentFiles || documentFiles.length === 0) {
      setStatus('Please select file(s) first');
      return;
    }
    
    setDocumentUploading(true);
    setStatus('Uploading and processing document(s)...');
    
    try {
      // Use the unified documents upload endpoint
      const formData = new FormData();
      documentFiles.forEach(file => {
        formData.append('files', file);
      });
      formData.append('language', selectedLanguage.toLowerCase());
      formData.append('query', '');  // Empty query for initial upload
      formData.append('chat_history', JSON.stringify([]));
      
      console.log('Uploading files:', documentFiles.map(f => f.name));
      
      const response = await fetch(`${API_URL}/upload_documents`, {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('Upload error:', errorData);
        throw new Error(errorData.detail || 'Documents upload failed');
      }
      
      const data = await response.json();
      console.log('Upload successful, processed documents:', data.documents?.length);
      
      if (!data.documents || data.documents.length === 0) {
        throw new Error('No documents could be processed.');
      }
      
      setDocuments(data.documents);
      setDocumentMode(true);
      
      setShowFileUploadModal(false);
      
      if (data.documents.length === 1) {
        const doc = data.documents[0];
        setStatus(`Document ready: ${doc.filename}${doc.is_image ? ' (Image)' : ''}`);
      } else {
        setStatus(`${data.documents.length} documents ready`);
      }
    } catch (error) {
      console.error('Error uploading document(s):', error);
      setStatus(`Upload error: ${error.message}`);
    } finally {
      setDocumentUploading(false);
    }
  };
  
  const sendDocumentQuery = async (query = textInput) => {
    if (!documents || documents.length === 0 || !query.trim() || isProcessing) return;
    
    setTextInput('');
    setIsProcessing(true);
    setStatus('Processing your document query...');
    
    try {
      // Get relevant chat history for document mode
      const relevantHistory = getRelevantChatHistory();
      
      // Query documents using the unified endpoint
      const response = await fetch(`${API_URL}/query_documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          documents: documents,
          chat_history: relevantHistory,
          language: selectedLanguage.toLowerCase()
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Documents query failed');
      }
      
      const { response: aiResponse } = await response.json();
      setChatHistory(prev => [...prev, { user: query, document: aiResponse }]);
      
      try {
        const ttsResponse = await fetch(`${API_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: aiResponse, 
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
          // setStatus('AI is responding...');
        } else {
          setStatus('AI response received');
        }
      } catch (ttsError) {
        console.error('TTS Error:', ttsError);
        setStatus('AI response received');
      }
    } catch (error) {
      console.error('Error processing document query:', error);
      setStatus(`Error: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Custom markdown components for better styling
  const markdownComponents = {
    // Headings
    h1: ({children}) => <h1 className="text-xl font-bold text-white mb-3">{children}</h1>,
    h2: ({children}) => <h2 className="text-lg font-bold text-white mb-2">{children}</h2>,
    h3: ({children}) => <h3 className="text-base font-semibold text-white mb-2">{children}</h3>,
    
    // Paragraphs
    p: ({children}) => <p className="text-gray-300 mb-2 leading-relaxed">{children}</p>,
    
    // Lists
    ul: ({children}) => <ul className="list-disc list-inside text-gray-300 mb-2 space-y-1">{children}</ul>,
    ol: ({children}) => <ol className="list-decimal list-inside text-gray-300 mb-2 space-y-1">{children}</ol>,
    li: ({children}) => <li className="text-gray-300">{children}</li>,
    
    // Emphasis
    strong: ({children}) => <strong className="text-white font-semibold">{children}</strong>,
    em: ({children}) => <em className="text-blue-200 italic">{children}</em>,
    
    // Code
    code: ({children, className}) => {
      const isInline = !className;
      return isInline ? (
        <code className="bg-gray-700 text-blue-200 px-1 py-0.5 rounded text-sm font-mono">
          {children}
        </code>
      ) : (
        <code className="block bg-gray-700 text-green-300 p-3 rounded-lg text-sm font-mono overflow-x-auto whitespace-pre">
          {children}
        </code>
      );
    },
    
    // Pre-formatted text
    pre: ({children}) => <div className="bg-gray-700 rounded-lg mb-2 overflow-hidden">{children}</div>,
    
    // Links
    a: ({href, children}) => (
      <a 
        href={href} 
        target="_blank" 
        rel="noopener noreferrer" 
        className="text-blue-400 hover:text-blue-300 underline"
      >
        {children}
      </a>
    ),
    
    // Blockquotes
    blockquote: ({children}) => (
      <blockquote className="border-l-4 border-blue-500 pl-4 text-gray-300 italic mb-2">
        {children}
      </blockquote>
    ),
    
    // Tables
    table: ({children}) => (
      <div className="overflow-x-auto mb-2">
        <table className="min-w-full border border-gray-600">
          {children}
        </table>
      </div>
    ),
    thead: ({children}) => <thead className="bg-gray-700">{children}</thead>,
    tbody: ({children}) => <tbody>{children}</tbody>,
    tr: ({children}) => <tr className="border-b border-gray-600">{children}</tr>,
    th: ({children}) => <th className="px-3 py-2 text-left text-white font-semibold">{children}</th>,
    td: ({children}) => <td className="px-3 py-2 text-gray-300">{children}</td>,
    
    // Horizontal rule
    hr: () => <hr className="border-gray-600 my-4" />,
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
        @media (max-width: 500px) {
          .mobile-hidden {
            display: none;
          }
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
        {/* Left Panel - Description - Hidden on mobile */}
        <div className="bg-slate-800 rounded-xl p-8 mobile-hidden">
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
              <span>Dual input modes: voice recording and text typing</span>
            </li>
            <li className="flex items-start">
              <span className="text-yellow-400 mr-3 mt-1">•</span>
              <span>Multi-language support (Hindi, English & Arabic)</span>
            </li>
            <li className="flex items-start">
              <span className="text-yellow-400 mr-3 mt-1">•</span>
              <span>Document upload and analysis (PDF, Word, Images) - Single or Multiple</span>
            </li>
          </ul>

          <p className="text-gray-300 leading-relaxed">
           Simply click the microphone button to start recording, or type your message directly. Upload single or multiple documents to ask questions about their content. Select your preferred language from the dropdown. The AI will respond with both text and voice, creating a natural conversation flow.
          </p>
        </div>

        {/* Right Panel - Voice AI Agent */}
        <div className="bg-slate-800 rounded-xl p-8 relative overflow-hidden flex flex-col h-[600px] lg:col-span-1 col-span-1">
          {/* Gradient Background Effect */}
          <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-blue-500/20 via-blue-600/10 to-transparent pointer-events-none"></div>
          
          {/* Status Bar with File Upload Button */}
          <div className="mb-6">
            <div className="flex items-center justify-between px-4 py-2 bg-gray-900/60 rounded-full">
              <div className="flex items-center space-x-2">
                <div className={`w-2 h-2 rounded-full ${
                  isRecording ? 'bg-red-400 animate-pulse' : 
                  isProcessing ? 'bg-yellow-400 animate-pulse' : 
                  'bg-green-400'
                }`}></div>
                <span className="text-white text-sm">{status}</span>
              </div>
              
              {/* File Upload Button or Remove Document Button */}
              {documentMode ? (
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-gray-300 truncate max-w-[100px]">
                    {documents.length === 1 ?
                      `${documents[0].filename} ${documents[0].is_image ? '�️' : '📄'}` :
                      `${documents.length} documents`
                    }
                  </span>
                  <button 
                    onClick={() => {
                      setDocumentMode(false);
                      setDocumentFiles([]);
                      setDocuments([]);
                      setStatus('Oodles technologies');
                    }}
                    className="text-white bg-red-600 hover:bg-red-500 rounded-full p-2 transition-all duration-200"
                    title="Remove documents"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <button 
                  onClick={() => setShowFileUploadModal(true)}
                  className="text-white bg-blue-600 hover:bg-blue-500 rounded-full p-2 transition-all duration-200"
                  title="Upload document(s)"
                  disabled={isProcessing || isRecording}
                >
                  <Upload size={16} />
                </button>
              )}
              
            </div>
          </div>
          
          {/* File Upload Modal */}
          {showFileUploadModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-gray-800 p-6 rounded-xl shadow-xl max-w-md w-full">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-semibold text-white">Upload from Device</h3>
                  <button 
                    onClick={() => setShowFileUploadModal(false)}
                    className="text-gray-400 hover:text-white"
                  >
                    <X size={20} />
                  </button>
                </div>
                
                <p className="text-gray-300 mb-4">
                  Upload document(s) and ask questions about their content. You can select one or multiple files.
                </p>
                
                <div className="bg-gray-700 p-3 rounded mb-4">
                  <p className="text-sm text-gray-300">
                    <strong>Supported files:</strong><br/>
                    • PDF documents<br/>
                    • Word documents (.doc, .docx)<br/>
                    • Images (.jpg, .png) - with visual analysis<br/>
                    • Text files (.txt)<br/>
                    • Maximum: 10 files
                  </p>
                </div>
                
                <div className="mb-4">
                  <label className="block mb-2 text-sm font-medium text-gray-300">
                    Select document(s)
                  </label>
                  <div className="flex items-center">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.txt"
                      multiple
                      className="hidden"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg flex items-center space-x-2"
                    >
                      <File size={16} />
                      <span>Choose files</span>
                    </button>
                    <span className="ml-3 text-sm text-gray-400">
                      {documentFiles && documentFiles.length > 0 ? 
                        documentFiles.length === 1 ? documentFiles[0].name : `${documentFiles.length} files selected` : 
                        'No files selected'
                      }
                    </span>
                  </div>
                </div>
                
                <div className="flex justify-end space-x-3">
                  <button
                    onClick={() => setShowFileUploadModal(false)}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleFileUpload}
                    disabled={
                      (!documentFiles || documentFiles.length === 0) || 
                      documentUploading
                    }
                    className={`px-4 py-2 rounded-lg flex items-center space-x-2 ${
                      ((!documentFiles || documentFiles.length === 0) || 
                       documentUploading)
                        ? 'bg-gray-600 cursor-not-allowed text-gray-400'
                        : 'bg-blue-600 hover:bg-blue-500 text-white'
                    }`}
                  >
                    {documentUploading ? (
                      <>
                        <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin mr-2"></div>
                        <span>Processing...</span>
                      </>
                    ) : (
                      <>
                        <Upload size={16} />
                        <span>Upload</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

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
                      {/* Show either 'ai' or 'document' response based on what exists */}
                      <ReactMarkdown components={markdownComponents}>
                        {chat.ai || chat.document}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))}
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
                    : (isProcessing && !isRecording)
                    ? 'bg-gray-600 cursor-not-allowed text-gray-400'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                }`}
                title={
                  isRecording ? 'Stop recording' : 
                  (isProcessing && !isRecording) ? 'Processing...' : 
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
                  placeholder={documentMode 
                    ? documents && documents.length === 1 
                      ? `Ask a question about the ${documents[0].is_image ? 'image' : 'document'}...`
                      : `Ask a question about the ${documents?.length || 0} documents...`
                    : "Type your message..."
                  }
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



