
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage, Blob as GeminiBlob } from '@google/genai';
import { Message, VoiceName, VoiceAssistantState, ToolCallResult, VoiceSettings, CustomClip } from './types';
import { encode, decode, decodeAudioData } from './utils/audio';

const COMMON_TAGS = ['funny', 'alarm', 'alert', 'intro', 'greeting', 'notification', 'emergency', 'siri', 'jarvis', 'glitch', 'success', 'error', 'warning', 'ui', 'system'];

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceAssistantState>({
    isActive: false,
    isConnecting: false,
    isListening: false,
    error: null
  });
  
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    voiceName: VoiceName.ZEPHYR,
    speed: 1.0,
    pitch: 1.0,
    customClips: []
  });

  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'voice' | 'clips'>('voice');
  const [lastToolResult, setLastToolResult] = useState<ToolCallResult | null>(null);
  
  // Edit State
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<CustomClip | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'close' | 'switch' | 'tab', data?: any } | null>(null);

  // Visualization State
  const [visualData, setVisualData] = useState<number[] | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);

  const [tagInput, setTagInput] = useState<string>('');
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [clipSearchQuery, setClipSearchQuery] = useState<string>('');
  
  // Recording state
  const [isRecordingClip, setIsRecordingClip] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeClipsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const transcriptionRef = useRef<{ user: string; model: string }>({ user: '', model: '' });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  
  // Recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);

  // --- Visualization Logic ---
  useEffect(() => {
    const generateVisualData = async () => {
      if (!editingClipId) {
        setVisualData(null);
        return;
      }
      const clip = voiceSettings.customClips.find(c => c.id === editingClipId);
      if (!clip) return;

      try {
        const response = await fetch(clip.url);
        const arrayBuffer = await response.arrayBuffer();
        const dummyCtx = new AudioContext();
        const audioBuffer = await dummyCtx.decodeAudioData(arrayBuffer);
        const rawData = audioBuffer.getChannelData(0);
        const samples = 100;
        const blockSize = Math.floor(rawData.length / samples);
        const filteredData = [];
        for (let i = 0; i < samples; i++) {
          let blockStart = blockSize * i;
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum = sum + Math.abs(rawData[blockStart + j]);
          }
          filteredData.push(sum / blockSize);
        }
        setVisualData(filteredData);
        dummyCtx.close();
      } catch (e) {
        console.error("Waveform generation failed", e);
      }
    };
    generateVisualData();
  }, [editingClipId, voiceSettings.customClips]);

  useEffect(() => {
    if (!waveformCanvasRef.current || !visualData) return;
    const canvas = waveformCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Speed affects visualization width
    const drawWidth = width / voiceSettings.speed;
    const startX = (width - drawWidth) / 2;
    
    // Pitch affects color spectrum
    const getPitchColor = (p: number) => {
      if (p < 0.8) return '#f59e0b'; // Amber
      if (p > 1.2) return '#a855f7'; // Purple/Violet
      return '#06b6d4'; // Cyan
    };

    const color = getPitchColor(voiceSettings.pitch);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 10;
    ctx.shadowColor = color + '55';

    ctx.beginPath();
    visualData.forEach((val, i) => {
      const x = startX + (i / visualData.length) * drawWidth;
      const h = val * height * 1.5;
      ctx.moveTo(x, height / 2 - h / 2);
      ctx.lineTo(x, height / 2 + h / 2);
    });
    ctx.stroke();
  }, [visualData, voiceSettings.speed, voiceSettings.pitch]);

  // --- Dirty Check Logic ---
  const isDirty = () => {
    if (!editingClipId || !pendingEdit) return false;
    const original = voiceSettings.customClips.find(c => c.id === editingClipId);
    if (!original) return false;

    const tagsMatch = JSON.stringify([...(original.tags || [])].sort()) === JSON.stringify([...(pendingEdit.tags || [])].sort());
    
    return (
      original.name !== pendingEdit.name ||
      (original.description || '') !== (pendingEdit.description || '') ||
      !tagsMatch
    );
  };

  const requestAction = (action: { type: 'close' | 'switch' | 'tab', data?: any }) => {
    if (isDirty()) {
      setConfirmAction(action);
      setShowConfirmModal(true);
    } else {
      executeAction(action);
    }
  };

  const executeAction = (action: { type: 'close' | 'switch' | 'tab', data?: any }) => {
    switch (action.type) {
      case 'close':
        setEditingClipId(null);
        setPendingEdit(null);
        setShowSettings(false);
        break;
      case 'switch':
        startEditing(action.data);
        break;
      case 'tab':
        setEditingClipId(null);
        setPendingEdit(null);
        setActiveTab(action.data);
        break;
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  // --- Search Utility ---
  const findBestClip = (query: string): CustomClip | null => {
    const q = query.toLowerCase().trim();
    if (!q || voiceSettings.customClips.length === 0) return null;

    let candidates = voiceSettings.customClips.map(clip => {
      let score = 0;
      const name = clip.name.toLowerCase();
      const desc = (clip.description || '').toLowerCase();
      const tags = (clip.tags || []).map(t => t.toLowerCase());

      if (q.includes('+')) {
        const terms = q.split('+').map(t => t.trim()).filter(Boolean);
        const allTermsMatch = terms.every(term => 
          name.includes(term) || desc.includes(term) || tags.some(tag => tag.includes(term))
        );
        if (allTermsMatch) score += 200;
      }

      const tokens = q.split(/[\s,]+/).filter(Boolean);
      tokens.forEach(token => {
        const tLen = token.length;

        if (name === token) {
          score += 150;
        } else if (name.includes(token)) {
          score += 70 * (tLen / name.length);
        }

        tags.forEach(tag => {
          if (tag === token) {
            score += 100;
          } else if (tag.includes(token)) {
            score += 40 * (tLen / tag.length);
          }
        });

        if (desc.includes(token)) {
          score += 20 * (tLen / Math.max(desc.length, 1));
        }
      });

      return { clip, score };
    });

    const filtered = candidates.filter(c => c.score > 0).sort((a, b) => b.score - a.score);
    return filtered.length > 0 ? filtered[0].clip : null;
  };

  // --- Recording Logic ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        const clip: CustomClip = {
          id: Math.random().toString(36).substr(2, 9),
          name: `Voice Record ${timestamp}`,
          url,
          blob,
          description: 'Live captured audio signal.',
          tags: ['recorded', 'live']
        };

        setVoiceSettings(prev => ({
          ...prev,
          customClips: [...prev.customClips, clip]
        }));
        
        startEditing(clip);
        
        // Cleanup stream
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setIsRecordingClip(true);
      setRecordingDuration(0);
      
      timerIntervalRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Recording failed:", err);
      setVoiceState(prev => ({ ...prev, error: "Microphone access denied for recording." }));
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecordingClip) {
      mediaRecorderRef.current.stop();
      setIsRecordingClip(false);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // --- Tag Logic ---
  const handleTagInputChange = (value: string) => {
    setTagInput(value);
    const tags = value.split(',').map(t => t.trim()).filter(t => t !== '');
    if (pendingEdit) {
      setPendingEdit({ ...pendingEdit, tags });
    }

    const parts = value.split(',');
    const currentPart = parts[parts.length - 1].trim().toLowerCase();

    if (currentPart.length > 0) {
      const existingTags: string[] = Array.from(new Set(voiceSettings.customClips.flatMap(c => c.tags || [])));
      const allPossible: string[] = Array.from(new Set([...COMMON_TAGS, ...existingTags]));
      
      const filtered = allPossible
        .filter((tag: string) => tag.toLowerCase().startsWith(currentPart) && !(pendingEdit?.tags || []).includes(tag))
        .slice(0, 5);
      setTagSuggestions(filtered);
    } else {
      setTagSuggestions([]);
    }
  };

  const applyTagSuggestion = (suggestion: string) => {
    const parts = tagInput.split(',');
    parts[parts.length - 1] = ` ${suggestion}`;
    const newValue = parts.join(',').trim();
    const tags = newValue.split(',').map(t => t.trim()).filter(t => t !== '');
    
    if (pendingEdit) {
      setPendingEdit({ ...pendingEdit, tags });
    }
    
    const nextVal = newValue + ', ';
    setTagInput(nextVal);
    setTagSuggestions([]);
    
    setTimeout(() => {
      tagInputRef.current?.focus();
    }, 0);
  };

  const getTools = (): FunctionDeclaration[] => [
    {
      name: 'get_current_time',
      description: 'Returns the current local time.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    {
      name: 'get_weather',
      description: 'Get weather information for a specific location.',
      parameters: {
        type: Type.OBJECT,
        properties: { location: { type: Type.STRING } },
        required: ['location']
      }
    },
    {
      name: 'search_google',
      description: 'Perform a web search for information.',
      parameters: {
        type: Type.OBJECT,
        properties: { query: { type: Type.STRING } },
        required: ['query']
      }
    },
    {
      name: 'play_custom_clip',
      description: "Trigger a custom audio clip. Supports advanced querying: use '+' for AND (e.g. 'alarm + loud') or separate terms with spaces for fuzzy matching.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          clip_query: { 
            type: Type.STRING, 
            description: `Query string to find the clip. Available index: ${voiceSettings.customClips.map(c => `"${c.name}" [tags: ${c.tags?.join(',') || 'none'}]`).join('; ')}` 
          }
        },
        required: ['clip_query']
      }
    }
  ];

  useEffect(() => {
    return () => {
      if (sessionRef.current) sessionRef.current.close();
      inputAudioCtxRef.current?.close();
      outputAudioCtxRef.current?.close();
      activeClipsRef.current.forEach(audio => {
        audio.pause();
        audio.src = '';
      });
      activeClipsRef.current.clear();
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const clip: CustomClip = {
      id: Math.random().toString(36).substr(2, 9),
      name: file.name.split('.')[0],
      url: URL.createObjectURL(file),
      blob: file,
      description: '',
      tags: []
    };

    setVoiceSettings(prev => ({
      ...prev,
      customClips: [...prev.customClips, clip]
    }));
    
    if (fileInputRef.current) fileInputRef.current.value = '';
    startEditing(clip);
  };

  const removeClip = (id: string) => {
    setVoiceSettings(prev => ({
      ...prev,
      customClips: prev.customClips.filter(c => c.id !== id)
    }));
    if (editingClipId === id) {
      setEditingClipId(null);
      setPendingEdit(null);
    }
  };

  const startEditing = (clip: CustomClip) => {
    setEditingClipId(clip.id);
    setPendingEdit({ ...clip });
    setTagInput(clip.tags?.join(', ') || '');
    setTagSuggestions([]);
  };

  const saveEditing = () => {
    if (pendingEdit && editingClipId) {
      setVoiceSettings(prev => ({
        ...prev,
        customClips: prev.customClips.map(c => c.id === editingClipId ? { ...pendingEdit } : c)
      }));
      setEditingClipId(null);
      setPendingEdit(null);
    }
  };

  const cancelEditing = () => {
    setEditingClipId(null);
    setPendingEdit(null);
  };

  const handleToolCall = async (fc: any) => {
    let result = "Done";
    switch (fc.name) {
      case 'get_current_time':
        result = new Date().toLocaleTimeString();
        break;
      case 'get_weather':
        result = `Current weather for ${fc.args.location}: 21°C and sunny.`;
        break;
      case 'search_google':
        result = `Results for ${fc.args.query}: Gemini is Google's most capable AI.`;
        break;
      case 'play_custom_clip':
        const clip = findBestClip(fc.args.clip_query);
        if (clip) {
          const isAssistantSpeaking = sourcesRef.current.size > 0;
          const isAnyClipActive = activeClipsRef.current.size > 0;

          if (!isAssistantSpeaking && !isAnyClipActive) {
            const audio = new Audio(clip.url);
            activeClipsRef.current.add(audio);
            
            const cleanup = () => {
              activeClipsRef.current.delete(audio);
              audio.onended = null;
              audio.onerror = null;
            };

            audio.onended = cleanup;
            audio.onerror = cleanup;
            
            audio.play().catch(err => {
              console.error("Audio playback failed:", err);
              cleanup();
            });
            
            result = `Matched and played signal: "${clip.name}"`;
          } else {
            result = `Matched signal "${clip.name}" but suppressed playback because another audio stream is active.`;
          }
        } else {
          result = `No matching signal found for query: "${fc.args.clip_query}". Ensure the signal is tagged correctly in the Voice Lab.`;
        }
        break;
    }

    setLastToolResult({ name: fc.name, args: fc.args, result });
    
    if (sessionRef.current) {
      sessionRef.current.sendToolResponse({
        functionResponses: {
          id: fc.id,
          name: fc.name,
          response: { result }
        }
      });
    }
  };

  const startAssistant = async () => {
    try {
      setVoiceState(prev => ({ ...prev, isConnecting: true, error: null }));
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceSettings.voiceName } }
          },
          systemInstruction: `You are Nova, an advanced AI. You can trigger user-uploaded audio signals. 
          The 'play_custom_clip' tool now supports boolean logic. 
          - Use '+' to find clips with multiple specific tags/words: e.g., 'alarm + emergency'.
          - Use natural keywords for fuzzy matching: e.g., 'funny clip'.
          
          Library Index:
          ${voiceSettings.customClips.map(c => `- CLIP: "${c.name}", TAGS: [${c.tags?.join(', ') || 'none'}], DESC: "${c.description || 'N/A'}"`).join('\n')}
          
          When a user refers to a sound or specific response in your library, determine the best query and execute 'play_custom_clip'.`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: getTools() }]
        },
        callbacks: {
          onopen: () => {
            setVoiceState(prev => ({ ...prev, isActive: true, isConnecting: false, isListening: true }));
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob: GeminiBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) transcriptionRef.current.user += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) transcriptionRef.current.model += message.serverContent.outputTranscription.text;
            if (message.serverContent?.turnComplete) {
              const uText = transcriptionRef.current.user;
              const mText = transcriptionRef.current.model;
              if (uText || mText) {
                setMessages(prev => [...prev, 
                  { id: Math.random().toString(), role: 'user', content: uText, timestamp: new Date() },
                  { id: Math.random().toString(), role: 'assistant', content: mText, timestamp: new Date() }
                ].slice(-10));
              }
              transcriptionRef.current = { user: '', model: '' };
            }
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) handleToolCall(fc);
            }
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              
              // Apply both Speed and Pitch logic
              source.playbackRate.value = voiceSettings.speed;
              // Use detune for harmonic pitch (1200 cents per octave)
              source.detune.value = Math.log2(voiceSettings.pitch) * 1200;
              
              const gainNode = ctx.createGain();
              source.connect(gainNode);
              gainNode.connect(ctx.destination);
              source.addEventListener('ended', () => { sourcesRef.current.delete(source); });
              
              source.start(nextStartTimeRef.current);
              
              // Important: Duration is affected by BOTH speed and pitch shifts
              const effectiveRate = voiceSettings.speed * voiceSettings.pitch;
              nextStartTimeRef.current += (audioBuffer.duration / effectiveRate);
              
              sourcesRef.current.add(source);
            }
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => setVoiceState(prev => ({ ...prev, error: 'Connection failure.' })),
          onclose: () => stopAssistant()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setVoiceState(prev => ({ ...prev, isConnecting: false, error: err.message }));
    }
  };

  const stopAssistant = () => {
    if (sessionRef.current) sessionRef.current.close();
    sessionRef.current = null;
    inputAudioCtxRef.current?.close();
    outputAudioCtxRef.current?.close();
    setVoiceState({ isActive: false, isConnecting: false, isListening: false, error: null });
  };

  // --- Filter Clips ---
  const filteredClips = voiceSettings.customClips.filter(clip => {
    const q = clipSearchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      clip.name.toLowerCase().includes(q) ||
      (clip.description || '').toLowerCase().includes(q) ||
      (clip.tags || []).some(t => t.toLowerCase().includes(q))
    );
  });

  return (
    <div className="min-h-screen flex flex-col items-center justify-between p-6 bg-slate-950 text-slate-100 selection:bg-blue-500/30">
      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 backdrop-blur-md bg-slate-950/40">
          <div className="glass w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl border-white/5 animate-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-amber-500/10 rounded-3xl flex items-center justify-center text-amber-500 mb-6 mx-auto border border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.1)]">
              <i className="fas fa-exclamation-triangle text-2xl"></i>
            </div>
            <h3 className="text-lg font-bold text-center mb-2 uppercase tracking-widest">Unsaved Changes</h3>
            <p className="text-slate-400 text-center text-sm mb-8 leading-relaxed">
              You have modified this audio signal. Closing will discard your metadata updates.
            </p>
            <div className="flex flex-col gap-3">
              <button 
                onClick={() => executeAction(confirmAction!)}
                className="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded-2xl transition-all shadow-lg shadow-red-600/20 text-xs uppercase tracking-widest"
              >
                Discard & Continue
              </button>
              <button 
                onClick={() => setShowConfirmModal(false)}
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-3 rounded-2xl transition-all text-xs uppercase tracking-widest"
              >
                Keep Editing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="w-full max-w-4xl flex items-center justify-between z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
            <i className="fas fa-robot text-xl"></i>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">NOVA <span className="text-blue-500">AI</span></h1>
            <p className="text-xs text-slate-400 font-medium tracking-widest uppercase">Sonic Engine V2.2</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {isRecordingClip && (
            <div className="flex items-center gap-2 bg-red-600/20 px-3 py-1 rounded-full border border-red-500/30 animate-pulse">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full"></span>
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-red-400">Recording</span>
            </div>
          )}
          <button 
            onClick={() => {
              if (showSettings) {
                requestAction({ type: 'close' });
              } else {
                setShowSettings(true);
              }
            }}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${showSettings ? 'bg-blue-600 text-white scale-110 shadow-lg shadow-blue-500/20' : 'bg-slate-900 text-slate-400 hover:text-white'}`}
          >
            <i className={`fas ${showSettings ? 'fa-times' : 'fa-sliders-h'}`}></i>
          </button>
          <div className="flex items-center gap-2 bg-slate-900/50 px-4 py-1.5 rounded-full border border-slate-800 backdrop-blur-sm">
             <span className={`w-2 h-2 rounded-full ${voiceState.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-700'}`}></span>
             <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
               {voiceState.isActive ? 'Link established' : 'Dormant'}
             </span>
          </div>
        </div>
      </header>

      {/* Main Interaction Area */}
      <main className="flex-1 w-full max-w-2xl flex flex-col items-center justify-center gap-10 py-12 relative">
        
        {/* Settings Overlay */}
        {showSettings && (
          <div className="absolute top-0 right-0 w-80 glass rounded-[2.5rem] p-6 shadow-2xl z-30 animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[80vh]">
            <div className="flex bg-slate-900/50 p-1 rounded-2xl mb-6 border border-slate-800 shrink-0">
              <button 
                onClick={() => requestAction({ type: 'tab', data: 'voice' })}
                className={`flex-1 text-[10px] font-bold uppercase py-2 rounded-xl transition-all ${activeTab === 'voice' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/10' : 'text-slate-500 hover:text-slate-300'}`}
              >
                Configuration
              </button>
              <button 
                onClick={() => requestAction({ type: 'tab', data: 'clips' })}
                className={`flex-1 text-[10px] font-bold uppercase py-2 rounded-xl transition-all ${activeTab === 'clips' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/10' : 'text-slate-500 hover:text-slate-300'}`}
              >
                Voice Lab
              </button>
            </div>

            <div className="overflow-y-auto flex-1 custom-scrollbar pr-1">
              {activeTab === 'voice' ? (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">Neural Persona</label>
                    <select 
                      value={voiceSettings.voiceName} 
                      onChange={(e) => setVoiceSettings({...voiceSettings, voiceName: e.target.value as VoiceName})}
                      disabled={voiceState.isActive}
                      className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50 appearance-none"
                    >
                      {Object.values(VoiceName).map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] font-bold uppercase text-slate-500">Processing Rate</label>
                      <span className="text-xs font-mono text-blue-400">{voiceSettings.speed.toFixed(1)}x</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.5" 
                      max="2.0" 
                      step="0.1" 
                      value={voiceSettings.speed} 
                      onChange={(e) => setVoiceSettings({...voiceSettings, speed: parseFloat(e.target.value)})} 
                      className="w-full accent-blue-500 h-1 bg-slate-800 rounded-lg cursor-pointer" 
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">Harmonic Pitch</label>
                      <span className="text-xs font-mono text-blue-400">{voiceSettings.pitch.toFixed(1)}x</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.5" 
                      max="1.5" 
                      step="0.1" 
                      value={voiceSettings.pitch} 
                      onChange={(e) => setVoiceSettings({...voiceSettings, pitch: parseFloat(e.target.value)})} 
                      className="w-full accent-blue-500 h-1 bg-slate-800 rounded-lg cursor-pointer" 
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Lab Header & Upload & Record */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold uppercase text-slate-500 tracking-widest">User Assets</label>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={isRecordingClip ? stopRecording : startRecording}
                          className={`text-[10px] px-2 py-1 rounded-lg border transition-all flex items-center gap-1.5 ${
                            isRecordingClip 
                              ? 'bg-red-600/20 text-red-400 border-red-500/30 animate-pulse' 
                              : 'bg-emerald-600/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-600/20'
                          }`}
                        >
                          <i className={`fas ${isRecordingClip ? 'fa-stop' : 'fa-microphone'} text-[9px]`}></i> 
                          {isRecordingClip ? `Stop (${formatDuration(recordingDuration)})` : 'Record'}
                        </button>
                        <button 
                          onClick={() => fileInputRef.current?.click()}
                          className="text-[10px] bg-blue-600/20 text-blue-400 px-2 py-1 rounded-lg border border-blue-500/30 hover:bg-blue-600/30 transition-colors"
                        >
                          <i className="fas fa-file-upload text-[9px] mr-1"></i> Upload
                        </button>
                      </div>
                      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept="audio/*" className="hidden" />
                    </div>

                    {/* Search Bar */}
                    <div className="relative group">
                      <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 group-focus-within:text-blue-500 transition-colors"></i>
                      <input 
                        type="text" 
                        placeholder="Filter signals..." 
                        value={clipSearchQuery}
                        onChange={(e) => setClipSearchQuery(e.target.value)}
                        className="w-full bg-slate-950/50 border border-slate-800 rounded-xl pl-8 pr-8 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50 transition-all placeholder:text-slate-600 font-medium"
                      />
                      {clipSearchQuery && (
                        <button 
                          onClick={() => setClipSearchQuery('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                        >
                          <i className="fas fa-times text-[10px]"></i>
                        </button>
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-3">
                    {filteredClips.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 opacity-40">
                         <i className="fas fa-broadcast-tower text-2xl mb-2 text-slate-600"></i>
                         <p className="text-[10px] text-slate-500 italic text-center uppercase tracking-widest font-bold">
                           {clipSearchQuery ? 'No matching frequencies' : 'Library is empty'}
                         </p>
                      </div>
                    ) : (
                      filteredClips.map(clip => {
                        const isEditing = editingClipId === clip.id;
                        return (
                          <div 
                            key={clip.id} 
                            className={`p-3 rounded-[1.5rem] flex flex-col gap-2 group transition-all duration-300 border ${
                              isEditing 
                                ? 'bg-slate-900 border-blue-500 ring-4 ring-blue-500/10 shadow-[0_0_20px_rgba(37,99,235,0.15)]' 
                                : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 overflow-hidden">
                                <button 
                                  onClick={() => {
                                    const audio = new Audio(clip.url);
                                    audio.play();
                                  }} 
                                  className="text-blue-500 hover:text-blue-400 shrink-0 transition-transform active:scale-90"
                                >
                                  <i className="fas fa-play-circle text-lg"></i>
                                </button>
                                <div className="flex flex-col overflow-hidden">
                                  <span className={`text-xs truncate font-bold transition-colors ${isEditing ? 'text-white' : 'text-slate-300'}`}>
                                    {isEditing ? (pendingEdit?.name || clip.name) : clip.name}
                                  </span>
                                  <div className="flex flex-wrap gap-1 mt-0.5">
                                    {(isEditing ? (pendingEdit?.tags || []) : (clip.tags || [])).map((tag, idx) => (
                                      <span key={idx} className="text-[8px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/20 font-mono tracking-tighter uppercase">{tag}</span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {isEditing ? (
                                  <button 
                                    onClick={saveEditing}
                                    className="p-1.5 text-emerald-400 hover:text-emerald-300 bg-emerald-400/10 rounded-lg border border-emerald-400/20"
                                    title="Commit Changes"
                                  >
                                    <i className="fas fa-check-circle text-[10px]"></i>
                                  </button>
                                ) : (
                                  <button 
                                    onClick={() => requestAction({ type: 'switch', data: clip })}
                                    className="p-1.5 text-slate-500 hover:text-blue-400 hover:bg-blue-400/10 rounded-lg transition-all"
                                    title="Edit Signal"
                                  >
                                    <i className="fas fa-edit text-[10px]"></i>
                                  </button>
                                )}
                                <button 
                                  onClick={() => removeClip(clip.id)} 
                                  className="text-slate-500 hover:text-red-400 p-1.5"
                                  title="Remove Signal"
                                >
                                  <i className="fas fa-trash text-[10px]"></i>
                                </button>
                              </div>
                            </div>
                            
                            {isEditing && (
                              <div className="pt-2 border-t border-slate-800 space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                                
                                {/* Sonic Profile Visualizer */}
                                <div className="space-y-1">
                                  <label className="text-[9px] uppercase text-slate-500 font-bold tracking-widest">Sonic Profile</label>
                                  <div className="bg-slate-950/80 rounded-xl p-2 border border-slate-800/50 flex items-center justify-center overflow-hidden">
                                    <canvas 
                                      ref={waveformCanvasRef} 
                                      width={260} 
                                      height={50} 
                                      className="w-full h-12 block opacity-80"
                                    />
                                  </div>
                                </div>

                                <div className="space-y-1">
                                  <label className="text-[9px] uppercase text-blue-400 font-bold tracking-widest">Signal Name</label>
                                  <input 
                                    type="text"
                                    placeholder="Give it a unique name"
                                    className="w-full bg-slate-950/80 border border-slate-800 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50 transition-all font-medium"
                                    value={pendingEdit?.name || ''}
                                    onChange={(e) => setPendingEdit(prev => prev ? { ...prev, name: e.target.value } : null)}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[9px] uppercase text-slate-500 font-bold tracking-widest">Description</label>
                                  <textarea 
                                    placeholder="What is this clip for?"
                                    className="w-full bg-slate-950/80 border border-slate-800 rounded-lg p-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50 resize-none h-16 transition-all font-medium"
                                    value={pendingEdit?.description || ''}
                                    onChange={(e) => setPendingEdit(prev => prev ? { ...prev, description: e.target.value } : null)}
                                  />
                                </div>
                                <div className="space-y-1 relative">
                                  <label className="text-[9px] uppercase text-slate-500 font-bold tracking-widest">Tags (comma separated)</label>
                                  <input 
                                    ref={tagInputRef}
                                    type="text"
                                    placeholder="e.g. funny, intro, alarm"
                                    autoComplete="off"
                                    className="w-full bg-slate-950/80 border border-slate-800 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50 transition-all font-mono"
                                    value={tagInput}
                                    onChange={(e) => handleTagInputChange(e.target.value)}
                                  />
                                  {tagSuggestions.length > 0 && (
                                    <div className="absolute left-0 right-0 top-full mt-1 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
                                      {tagSuggestions.map((suggestion, idx) => (
                                        <button
                                          key={idx}
                                          onMouseDown={(e) => { e.preventDefault(); applyTagSuggestion(suggestion); }}
                                          className="w-full text-left px-3 py-2 text-[10px] font-mono text-slate-300 hover:bg-blue-600 hover:text-white transition-colors border-b border-slate-800/50 last:border-0"
                                        >
                                          <i className="fas fa-plus-circle mr-2 opacity-50"></i>
                                          {suggestion}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <button 
                                  onClick={cancelEditing}
                                  className="w-full text-[9px] uppercase text-slate-500 font-bold hover:text-slate-300 transition-colors pt-2"
                                >
                                  Cancel Changes
                                </button>
                              </div>
                            )}
                            {!isEditing && clip.description && (
                              <p className="text-[10px] text-slate-500 italic px-1 line-clamp-1 leading-relaxed">{clip.description}</p>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                  <p className="text-[9px] text-slate-500 leading-tight">Nova: Signal integrity confirmed. Spectral visualization active.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Visual Core */}
        <div className="relative flex items-center justify-center group">
          {voiceState.isActive && (
             <div className="absolute inset-0 rounded-full animate-ping bg-blue-500/10 opacity-75"></div>
          )}
          {voiceState.isListening && (
            <div className="absolute inset-0 bg-blue-500/20 rounded-full blur-3xl animate-pulse scale-150"></div>
          )}
          
          <button
            onClick={voiceState.isActive ? stopAssistant : startAssistant}
            disabled={voiceState.isConnecting}
            className={`relative z-10 w-40 h-40 rounded-full flex items-center justify-center transition-all duration-700 ${
              voiceState.isActive 
                ? 'bg-blue-600 shadow-[0_0_80px_rgba(37,99,235,0.4)] rotate-180' 
                : 'bg-slate-900 hover:bg-slate-800 shadow-2xl border border-slate-800'
            } ${voiceState.isConnecting ? 'animate-pulse' : ''}`}
          >
            <i className={`fas ${voiceState.isActive ? 'fa-dna' : 'fa-microphone-alt'} text-5xl text-white`}></i>
          </button>

          {voiceState.isActive && (
            <div className="absolute inset-0 -m-4 pointer-events-none">
              <div className="absolute inset-0 border-[3px] border-dashed border-blue-500/20 rounded-full animate-[spin_20s_linear_infinite]"></div>
              <div className="absolute inset-0 border border-slate-800 rounded-full animate-[spin_30s_linear_infinite_reverse]"></div>
            </div>
          )}
        </div>

        {/* Status */}
        <div className="text-center space-y-3">
          <p className="text-xl font-light tracking-widest text-slate-100 uppercase">
            {voiceState.isConnecting ? 'Syncing...' : voiceState.isActive ? 'Linked' : 'Ready'}
          </p>
          <div className="flex flex-col items-center gap-1">
             <p className="text-xs text-slate-500 font-mono italic">
               {voiceState.isActive ? `Monitoring Input via ${voiceSettings.voiceName} Profile` : 'Initiate sequence to interact'}
             </p>
             {voiceSettings.customClips.length > 0 && voiceState.isActive && (
               <span className="text-[10px] text-emerald-500/60 font-mono uppercase tracking-tighter">
                 Meta-Enabled Assets Loaded ({voiceSettings.customClips.length})
               </span>
             )}
          </div>
        </div>

        {/* Action Overlay */}
        {lastToolResult && (
           <div className="glass px-6 py-4 rounded-[1.5rem] flex items-start gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500 max-w-sm">
             <div className="w-8 h-8 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                <i className={`fas ${lastToolResult.name === 'play_custom_clip' ? 'fa-volume-up' : 'fa-microchip'}`}></i>
             </div>
             <div className="overflow-hidden">
               <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Execution Log</p>
               <p className="text-xs font-mono text-slate-300 leading-tight">
                 <span className="text-blue-500/70">{lastToolResult.name}:</span> {lastToolResult.result}
               </p>
             </div>
           </div>
        )}

        {voiceState.error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-6 py-3 rounded-2xl flex items-center gap-3 backdrop-blur-md">
            <i className="fas fa-exclamation-triangle"></i>
            <span className="text-xs font-medium tracking-wide">{voiceState.error}</span>
          </div>
        )}
      </main>

      {/* Terminal History */}
      <aside className="w-full max-w-4xl h-48 overflow-y-auto glass rounded-[2.5rem] p-6 flex flex-col gap-4 custom-scrollbar">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-800 text-[10px] font-bold tracking-[0.4em] uppercase opacity-50">
            Waiting for Signal...
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="flex gap-4 border-b border-white/5 pb-3 last:border-0 group">
              <div className={`mt-0.5 text-[10px] font-black uppercase tracking-widest shrink-0 ${msg.role === 'user' ? 'text-blue-500' : 'text-emerald-500'}`}>
                {msg.role === 'user' ? '» USER' : '« NOVA'}
              </div>
              <div className="text-xs text-slate-300 leading-relaxed font-medium group-hover:text-white transition-colors">
                {msg.content}
              </div>
            </div>
          ))
        )}
      </aside>

      {/* Specs */}
      <footer className="w-full max-w-4xl mt-8 pt-4 flex flex-wrap justify-center gap-x-12 gap-y-2 opacity-20 hover:opacity-100 transition-opacity">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.2em]">
          <span className="text-blue-500">MDL</span> Flash 2.5
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.2em]">
          <span className="text-blue-500">AUD</span> 24KHZ PCM
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.2em]">
          <span className="text-blue-500">USR</span> Meta-Signals V2.2
        </div>
      </footer>
    </div>
  );
}
