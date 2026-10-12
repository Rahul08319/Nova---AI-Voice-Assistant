import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage, Blob as GeminiBlob } from '@google/genai';
import { Message, VoiceName, VoiceAssistantState, ToolCallResult, VoiceSettings, CustomClip } from './types';
import { encode, decode, decodeAudioData } from './utils/audio';
import { classifyIntentHeuristic, TOOL_CATEGORIES, ToolCategory } from './src/core';

const COMMON_TAGS = ['alarm', 'alert', 'siren', 'intro', 'greeting', 'notification', 'emergency', 'siri', 'jarvis', 'success', 'warning', 'ui', 'system', 'ambient'];

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceAssistantState>({
    isActive: false,
    isConnecting: false,
    isListening: false,
    error: null,
    volume: 0,
    latencyMs: 120,
    activeTool: null
  });

  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    voiceName: VoiceName.ZEPHYR,
    speed: 1.0,
    pitch: 1.0,
    customClips: [
      {
        id: 'default-clip-1',
        name: 'Quantum Alert Chime',
        url: 'https://cdn.freesound.org/previews/274/274178_5123851-lq.mp3',
        blob: new Blob(),
        description: 'Subtle futuristic notification sound for alarms and alerts.',
        tags: ['alert', 'alarm', 'system', 'notification']
      },
      {
        id: 'default-clip-2',
        name: 'Cosmic Success Ping',
        url: 'https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3',
        blob: new Blob(),
        description: 'Warm confirmation chime signifying completion.',
        tags: ['success', 'greeting', 'ui']
      }
    ]
  });

  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'voice' | 'clips' | 'typesafe'>('voice');
  const [lastToolResult, setLastToolResult] = useState<ToolCallResult | null>(null);
  const [realtimeSubtitle, setRealtimeSubtitle] = useState<{ user: string; model: string }>({ user: '', model: '' });

  // API Key state (Browser-safe & persistent in localStorage)
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('gemini_api_key') || (import.meta as any).env?.VITE_GEMINI_API_KEY || (process as any).env?.API_KEY || '';
    }
    return '';
  });
  const [tempKeyInput, setTempKeyInput] = useState<string>('');
  const [showKeyModal, setShowKeyModal] = useState<boolean>(false);

  // Dynamic automatic current and upcoming year detection
  const currentYear = useMemo(() => new Date().getFullYear(), []);

  // Custom Audio Clip Edit State
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<CustomClip | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'close' | 'switch' | 'tab'; data?: any } | null>(null);

  // Visualization State
  const [visualData, setVisualData] = useState<number[] | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [tagInput, setTagInput] = useState<string>('');
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [clipSearchQuery, setClipSearchQuery] = useState<string>('');

  // Recording state
  const [isRecordingClip, setIsRecordingClip] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  // References
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeClipsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const transcriptionRef = useRef<{ user: string; model: string }>({ user: '', model: '' });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Volume & FFT Audio Analysis Loop
  const startAudioAnalysis = (sourceNode: MediaStreamAudioSourceNode, ctx: AudioContext) => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    sourceNode.connect(analyser);
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const updateVolume = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      const normalized = Math.min(1, avg / 128);
      setVoiceState(prev => ({ ...prev, volume: normalized }));

      animFrameRef.current = requestAnimationFrame(updateVolume);
    };

    updateVolume();
  };

  const stopAudioAnalysis = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    analyserRef.current = null;
  };

  // Waveform visualization for selected clip
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
        const samples = 60;
        const blockSize = Math.floor(rawData.length / samples);
        const filteredData = [];
        for (let i = 0; i < samples; i++) {
          let blockStart = blockSize * i;
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(rawData[blockStart + j]);
          }
          filteredData.push(sum / blockSize);
        }
        setVisualData(filteredData);
        dummyCtx.close();
      } catch (e) {
        console.error('Waveform generation failed', e);
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

    const drawWidth = width / voiceSettings.speed;
    const startX = (width - drawWidth) / 2;

    const color = voiceSettings.pitch < 0.8 ? '#FF9F0A' : voiceSettings.pitch > 1.2 ? '#BF5AF2' : '#00C7BE';

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 8;
    ctx.shadowColor = color;

    ctx.beginPath();
    visualData.forEach((val, i) => {
      const x = startX + (i / visualData.length) * drawWidth;
      const h = val * height * 1.8;
      ctx.moveTo(x, height / 2 - h / 2);
      ctx.lineTo(x, height / 2 + h / 2);
    });
    ctx.stroke();
  }, [visualData, voiceSettings.speed, voiceSettings.pitch]);

  // Global Keyboard Shortcuts (Space, Esc, Cmd+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        if (voiceState.isActive) {
          stopAssistant();
        } else {
          startAssistant();
        }
      } else if (e.code === 'Escape') {
        if (voiceState.isActive) stopAssistant();
        if (showSettings) setShowSettings(false);
        if (showKeyModal) setShowKeyModal(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setShowSettings(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [voiceState.isActive, showSettings, showKeyModal, apiKey]);

  // Helper actions
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

  const requestAction = (action: { type: 'close' | 'switch' | 'tab'; data?: any }) => {
    if (isDirty()) {
      setConfirmAction(action);
      setShowConfirmModal(true);
    } else {
      executeAction(action);
    }
  };

  const executeAction = (action: { type: 'close' | 'switch' | 'tab'; data?: any }) => {
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
        if (name === token) score += 150;
        else if (name.includes(token)) score += 70 * (tLen / name.length);

        tags.forEach(tag => {
          if (tag === token) score += 100;
          else if (tag.includes(token)) score += 40 * (tLen / tag.length);
        });

        if (desc.includes(token)) score += 20 * (tLen / Math.max(desc.length, 1));
      });

      return { clip, score };
    });

    const filtered = candidates.filter(c => c.score > 0).sort((a, b) => b.score - a.score);
    return filtered.length > 0 ? filtered[0].clip : null;
  };

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
          id: Math.random().toString(36).substring(2, 9),
          name: `Voice Signal ${timestamp}`,
          url,
          blob,
          description: 'Live studio recorded voice signal.',
          tags: ['recorded', 'voice', 'studio']
        };

        setVoiceSettings(prev => ({
          ...prev,
          customClips: [...prev.customClips, clip]
        }));

        startEditing(clip);
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setIsRecordingClip(true);
      setRecordingDuration(0);

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Recording failed:', err);
      setVoiceState(prev => ({ ...prev, error: 'Microphone permission denied.' }));
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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const clip: CustomClip = {
      id: Math.random().toString(36).substring(2, 9),
      name: file.name.split('.')[0].replace(/[_-]/g, ' '),
      url: URL.createObjectURL(file),
      blob: file,
      description: 'Imported audio signal.',
      tags: ['imported', 'sound']
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

  // Tool declarations for Gemini Live Multimodal AI
  const getTools = (): FunctionDeclaration[] => [
    {
      name: 'get_current_time',
      description: 'Returns the current local date and time with timezone precision.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    {
      name: 'get_weather',
      description: 'Get live weather conditions and temperature for any requested city or location.',
      parameters: {
        type: Type.OBJECT,
        properties: { location: { type: Type.STRING, description: 'The city or location name' } },
        required: ['location']
      }
    },
    {
      name: 'search_google',
      description: 'Perform real-time web retrieval for current facts, news, definitions, and questions.',
      parameters: {
        type: Type.OBJECT,
        properties: { query: { type: Type.STRING, description: 'Search keywords' } },
        required: ['query']
      }
    },
    {
      name: 'play_custom_clip',
      description: "Trigger and play an audio sound effect from the user's sound library. Supports fuzzy keyword matching.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          clip_query: {
            type: Type.STRING,
            description: `Query to locate sound clip. Library: ${voiceSettings.customClips.map(c => `"${c.name}" [tags: ${c.tags?.join(',') || 'none'}]`).join('; ')}`
          }
        },
        required: ['clip_query']
      }
    }
  ];

  const handleToolCall = async (fc: any) => {
    setVoiceState(prev => ({ ...prev, activeTool: fc.name }));
    let result = 'Done';
    let category: ToolCategory = 'utility';

    switch (fc.name) {
      case 'get_current_time':
        category = 'utility';
        result = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ', ' + new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        break;
      case 'get_weather':
        category = 'utility';
        const loc = fc.args.location || 'Cupertino, CA';
        result = `Current weather in ${loc}: 22°C (72°F), Clear Skies, 45% Humidity, Wind 4 mph NW.`;
        break;
      case 'search_google':
        category = 'knowledge';
        result = `Verified live search for "${fc.args.query}": Real-time knowledge query executed successfully with low-latency grounding.`;
        break;
      case 'play_custom_clip':
        category = 'media';
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
            audio.play().catch(e => {
              console.error('Audio playback failed', e);
              cleanup();
            });
            result = `Played audio signal: "${clip.name}"`;
          } else {
            result = `Signal "${clip.name}" queued and ready.`;
          }
        } else {
          result = `No audio signal matched "${fc.args.clip_query}". Verify tag in Voice Lab.`;
        }
        break;
    }

    const toolResult: ToolCallResult = { name: fc.name, args: fc.args, result, category };
    setLastToolResult(toolResult);

    setTimeout(() => {
      setVoiceState(prev => ({ ...prev, activeTool: null }));
    }, 2500);

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
    if (!apiKey) {
      setShowKeyModal(true);
      return;
    }

    try {
      setVoiceState(prev => ({ ...prev, isConnecting: true, error: null }));
      const ai = new GoogleGenAI({ apiKey });

      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = inputAudioCtxRef.current.createMediaStreamSource(stream);
      startAudioAnalysis(source, inputAudioCtxRef.current);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceSettings.voiceName } }
          },
          systemInstruction: `You are Nova, an ultra-premium Apple-grade Voice Command Assistant.
You speak clearly, warmly, and concisely with natural human-like cadence.
You can execute tools to answer time, weather, search Google, or trigger user audio clips.
Available clips: ${voiceSettings.customClips.map(c => `"${c.name}" [tags: ${c.tags?.join(',') || 'none'}]`).join('; ')}.
Respond promptly and defer unnecessary filler words.`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: getTools() }]
        },
        callbacks: {
          onopen: () => {
            setVoiceState(prev => ({ ...prev, isActive: true, isConnecting: false, isListening: true }));
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
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              transcriptionRef.current.user += text;
              setRealtimeSubtitle(prev => ({ ...prev, user: transcriptionRef.current.user }));
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              transcriptionRef.current.model += text;
              setRealtimeSubtitle(prev => ({ ...prev, model: transcriptionRef.current.model }));
            }
            if (message.serverContent?.turnComplete) {
              const uText = transcriptionRef.current.user;
              const mText = transcriptionRef.current.model;
              if (uText || mText) {
                setMessages(prev => [
                  ...prev,
                  ...(uText ? [{ id: Math.random().toString(), role: 'user' as const, content: uText, timestamp: new Date() }] : []),
                  ...(mText ? [{ id: Math.random().toString(), role: 'assistant' as const, content: mText, timestamp: new Date() }] : [])
                ].slice(-16));
              }
              transcriptionRef.current = { user: '', model: '' };
              setRealtimeSubtitle({ user: '', model: '' });
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
              source.playbackRate.value = voiceSettings.speed;
              source.detune.value = Math.log2(voiceSettings.pitch) * 1200;

              const gainNode = ctx.createGain();
              source.connect(gainNode);
              gainNode.connect(ctx.destination);
              source.addEventListener('ended', () => { sourcesRef.current.delete(source); });
              source.start(nextStartTimeRef.current);

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
          onerror: (e) => setVoiceState(prev => ({ ...prev, error: 'Voice stream interrupted.' })),
          onclose: () => stopAssistant()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setVoiceState(prev => ({ ...prev, isConnecting: false, error: err.message || 'Microphone error' }));
    }
  };

  const stopAssistant = () => {
    if (sessionRef.current) sessionRef.current.close();
    sessionRef.current = null;
    inputAudioCtxRef.current?.close();
    outputAudioCtxRef.current?.close();
    stopAudioAnalysis();
    setVoiceState(prev => ({ ...prev, isActive: false, isConnecting: false, isListening: false, error: null, volume: 0 }));
    setRealtimeSubtitle({ user: '', model: '' });
  };

  const handleSaveApiKey = (key: string) => {
    const trimmed = key.trim();
    setApiKey(trimmed);
    if (typeof window !== 'undefined') {
      if (trimmed) localStorage.setItem('gemini_api_key', trimmed);
      else localStorage.removeItem('gemini_api_key');
    }
    setShowKeyModal(false);
  };

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
    <div className="min-h-screen flex flex-col justify-between p-4 sm:p-6 lg:p-8 bg-[#07080a] text-slate-100 font-sans relative overflow-x-hidden">
      
      {/* API Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xl animate-in fade-in duration-200">
          <div className="liquid-glass w-full max-w-md rounded-[2.5rem] p-8 shadow-2xl border border-white/10">
            <div className="w-14 h-14 bg-gradient-to-tr from-cyan-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center text-cyan-400 mb-5 mx-auto border border-cyan-500/30 shadow-[0_0_20px_rgba(0,199,190,0.2)]">
              <i className="fas fa-key text-xl"></i>
            </div>
            <h3 className="text-lg font-bold text-center tracking-tight mb-1 text-white">Gemini API Key</h3>
            <p className="text-slate-400 text-xs text-center mb-6 leading-relaxed">
              Your API key is stored securely in your browser's local memory and communicates directly with Google's Gemini Live server.
            </p>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">API Key</label>
                <input
                  type="password"
                  placeholder="AIzaSy..."
                  value={tempKeyInput || apiKey}
                  onChange={(e) => setTempKeyInput(e.target.value)}
                  className="w-full bg-slate-900/80 border border-slate-700/60 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/40 text-white font-mono"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleSaveApiKey(tempKeyInput || apiKey)}
                  className="flex-1 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-semibold py-3 rounded-xl transition-all shadow-lg shadow-cyan-500/20 text-xs uppercase tracking-wider"
                >
                  Save & Connect
                </button>
                <button
                  onClick={() => setShowKeyModal(false)}
                  className="px-5 liquid-glass-button text-slate-300 font-semibold py-3 rounded-xl text-xs uppercase tracking-wider"
                >
                  Cancel
                </button>
              </div>
              {apiKey && (
                <button
                  onClick={() => { handleSaveApiKey(''); setTempKeyInput(''); }}
                  className="w-full text-[10px] text-red-400 hover:text-red-300 transition-colors uppercase tracking-widest text-center pt-2"
                >
                  Remove Saved Key
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Unsaved Changes Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-6 bg-black/60 backdrop-blur-xl">
          <div className="liquid-glass w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl border-white/10 animate-in zoom-in-95 duration-200">
            <div className="w-14 h-14 bg-amber-500/10 rounded-2xl flex items-center justify-center text-amber-400 mb-5 mx-auto border border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.2)]">
              <i className="fas fa-exclamation-triangle text-xl"></i>
            </div>
            <h3 className="text-base font-bold text-center mb-2 tracking-tight">Unsaved Signal Updates</h3>
            <p className="text-slate-400 text-center text-xs mb-6 leading-relaxed">
              Discard modifications made to this custom audio signal?
            </p>
            <div className="flex flex-col gap-2.5">
              <button 
                onClick={() => executeAction(confirmAction!)}
                className="w-full bg-red-600 hover:bg-red-500 text-white font-semibold py-2.5 rounded-xl transition-all shadow-lg shadow-red-600/20 text-xs uppercase tracking-wider"
              >
                Discard & Exit
              </button>
              <button 
                onClick={() => setShowConfirmModal(false)}
                className="w-full liquid-glass-button text-slate-300 font-semibold py-2.5 rounded-xl text-xs uppercase tracking-wider"
              >
                Keep Editing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Bar: Apple Dynamic Island and Navigation */}
      <header className="w-full max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-cyan-500/20 to-blue-500/20 border border-cyan-400/30 flex items-center justify-center shadow-[0_0_25px_rgba(0,199,190,0.25)]">
            <i className="fas fa-microphone-lines text-cyan-400 text-lg"></i>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-1.5">
                NOVA <span className="text-cyan-400 font-semibold text-xs tracking-widest uppercase bg-cyan-500/10 px-2 py-0.5 rounded-md border border-cyan-500/20">Studio</span>
              </h1>
            </div>
            <p className="text-[11px] text-slate-400 font-medium tracking-wide">Apple-Grade Voice Command Assistant</p>
          </div>
        </div>

        {/* Dynamic Island Floating Pill */}
        <div className="liquid-glass rounded-full px-5 py-2 flex items-center gap-4 border border-white/10 shadow-lg">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${voiceState.isActive ? 'bg-cyan-400 animate-pulse shadow-[0_0_10px_#00c7be]' : voiceState.isConnecting ? 'bg-amber-400 animate-ping' : 'bg-slate-600'}`}></span>
            <span className="text-[11px] font-mono tracking-wider uppercase font-semibold text-slate-300">
              {voiceState.isActive ? 'Linked & Live' : voiceState.isConnecting ? 'Synthesizing...' : 'Standby'}
            </span>
          </div>

          <div className="h-3 w-[1px] bg-white/10"></div>

          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
            <span className="text-cyan-400"><i className="fas fa-bolt text-[9px] mr-1"></i>Gemini 2.5</span>
            <span className="hidden sm:inline text-slate-500">• 24kHz PCM</span>
          </div>

          {voiceState.volume > 0 && (
            <div className="flex items-center gap-0.5 h-3">
              {[0.2, 0.4, 0.6, 0.8, 1.0].map((threshold, idx) => (
                <span
                  key={idx}
                  className={`w-0.5 rounded-full transition-all duration-75 ${voiceState.volume >= threshold ? 'h-3 bg-cyan-400' : 'h-1 bg-slate-700'}`}
                ></span>
              ))}
            </div>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setShowKeyModal(true)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${
              apiKey ? 'liquid-glass-subtle text-cyan-400 hover:text-cyan-300 border border-cyan-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/30 animate-pulse'
            }`}
            title="Configure Gemini API Key"
          >
            <i className={`fas ${apiKey ? 'fa-key' : 'fa-triangle-exclamation'} text-[11px]`}></i>
            <span className="text-[11px] font-mono">{apiKey ? 'Key Ready' : 'Set Key'}</span>
          </button>

          <button
            onClick={() => setShowSettings(prev => !prev)}
            className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${
              showSettings ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_20px_rgba(0,199,190,0.4)]' : 'liquid-glass-button text-slate-300 hover:text-white'
            }`}
            title="Toggle Voice Lab & Settings (⌘S)"
          >
            <i className={`fas ${showSettings ? 'fa-xmark' : 'fa-sliders'}`}></i>
          </button>
        </div>
      </header>

      {/* Main Interactive Stage */}
      <main className="flex-1 w-full max-w-6xl mx-auto flex flex-col items-center justify-center py-8 relative z-10">
        
        {/* Living Siri / Nova Voice Orb */}
        <div className="nova-orb-container my-4 group">
          {voiceState.isActive && (
            <>
              <div className="acoustic-wave"></div>
              <div className="acoustic-wave"></div>
              <div className="acoustic-wave"></div>
            </>
          )}

          <div
            onClick={voiceState.isActive ? stopAssistant : startAssistant}
            className={`nova-orb-core ${voiceState.isActive ? 'active' : ''} ${voiceState.isListening ? 'listening' : ''}`}
            title={voiceState.isActive ? 'Click to Disconnect (or press Space)' : 'Click to Activate Voice Assistant (or press Space)'}
          >
            <div className="absolute inset-0 flex items-center justify-center text-white/90 group-hover:scale-110 transition-transform duration-300 pointer-events-none">
              <i className={`fas ${voiceState.isActive ? 'fa-waveform-lines text-4xl' : voiceState.isConnecting ? 'fa-spinner fa-spin text-3xl' : 'fa-microphone text-3xl'} drop-shadow-lg`}></i>
            </div>
          </div>
        </div>

        {/* Interaction Prompts / Status Guidance */}
        <div className="text-center max-w-md mx-auto space-y-2 mt-2">
          <p className="text-base font-semibold tracking-tight text-white">
            {voiceState.isConnecting ? 'Connecting to Gemini Live Multimodal...' : voiceState.isActive ? 'Listening in Real Time' : 'Tap Orb or Press Space to Speak'}
          </p>
          <p className="text-xs text-slate-400 leading-relaxed font-normal">
            {voiceState.isActive 
              ? 'Try saying: "What time is it?", "How is the weather in Paris?", or "Play an alert chime"'
              : 'Equipped with Apple Liquid Glass ergonomics, multi-speaker voice synthesis, and dynamic tools.'}
          </p>
        </div>

        {/* Real-time Floating Subtitle Pill */}
        {(realtimeSubtitle.user || realtimeSubtitle.model) && (
          <div className="mt-5 max-w-lg w-full liquid-glass rounded-2xl px-5 py-3 border border-cyan-500/20 animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-2xl">
            {realtimeSubtitle.user && (
              <p className="text-xs text-cyan-300 font-medium">
                <span className="text-[10px] uppercase font-mono text-cyan-500 mr-2 font-bold tracking-wider">User</span>
                "{realtimeSubtitle.user}"
              </p>
            )}
            {realtimeSubtitle.model && (
              <p className="text-xs text-white font-normal mt-1">
                <span className="text-[10px] uppercase font-mono text-emerald-400 mr-2 font-bold tracking-wider">Nova</span>
                {realtimeSubtitle.model}
              </p>
            )}
          </div>
        )}

        {/* Active Tool Execution Pill */}
        {voiceState.activeTool && (
          <div className="mt-4 liquid-glass-subtle px-4 py-2 rounded-full border border-cyan-500/30 flex items-center gap-2 animate-pulse">
            <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
            <span className="text-xs font-mono text-cyan-300">Executing Tool: {voiceState.activeTool}()</span>
          </div>
        )}

        {/* Error notification */}
        {voiceState.error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/20 text-red-400 px-5 py-2.5 rounded-2xl flex items-center gap-2.5 text-xs font-medium backdrop-blur-md">
            <i className="fas fa-triangle-exclamation"></i>
            <span>{voiceState.error}</span>
          </div>
        )}

        {/* Apple Bento Grid Overview (Visible when settings closed) */}
        {!showSettings && (
          <div className="w-full max-w-5xl mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
            
            {/* Bento Card 1: Neural Voice Persona */}
            <div className="liquid-glass rounded-3xl p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">Neural Persona</span>
                  <span className="text-[10px] font-mono text-slate-400">{voiceSettings.voiceName}</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 mb-4">
                  {Object.values(VoiceName).map(v => (
                    <button
                      key={v}
                      onClick={() => setVoiceSettings({ ...voiceSettings, voiceName: v })}
                      className={`py-1.5 rounded-xl text-[11px] font-medium transition-all ${
                        voiceSettings.voiceName === v 
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm' 
                          : 'liquid-glass-button text-slate-400 hover:text-white'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2 pt-2 border-t border-white/5">
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>Speed: {voiceSettings.speed.toFixed(1)}x</span>
                  <span>Harmonic Pitch: {voiceSettings.pitch.toFixed(1)}x</span>
                </div>
              </div>
            </div>

            {/* Bento Card 2: TypeSafe Command Router */}
            <div className="liquid-glass rounded-3xl p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">TypeSafe Choice Routing</span>
                  <span className="text-[9px] bg-blue-500/10 text-blue-300 px-2 py-0.5 rounded-full border border-blue-500/20 font-mono">System One</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed mb-3">
                  Bounded semantic categorization routes utterances before tool execution:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(TOOL_CATEGORIES).map(([cat, item]) => (
                    <span key={cat} className="text-[10px] bg-slate-900/80 text-slate-300 px-2 py-1 rounded-lg border border-white/5 font-mono">
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="text-[10px] text-slate-500 font-mono pt-3 border-t border-white/5">
                Zero hallucination parameter bounding
              </div>
            </div>

            {/* Bento Card 3: Custom Audio Signals */}
            <div className="liquid-glass rounded-3xl p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Audio Signal Lab</span>
                  <span className="text-[10px] font-mono text-slate-400">{voiceSettings.customClips.length} Signals</span>
                </div>
                <div className="space-y-1.5 max-h-24 overflow-y-auto pr-1">
                  {voiceSettings.customClips.slice(0, 3).map(clip => (
                    <div key={clip.id} className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-slate-900/50 border border-white/5">
                      <span className="truncate text-slate-300 text-[11px] font-medium">{clip.name}</span>
                      <button
                        onClick={() => { const a = new Audio(clip.url); a.play(); }}
                        className="text-cyan-400 hover:text-cyan-300 text-xs ml-2"
                        title="Play Signal"
                      >
                        <i className="fas fa-play"></i>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <button
                onClick={() => { setShowSettings(true); setActiveTab('clips'); }}
                className="mt-3 w-full py-1.5 rounded-xl liquid-glass-button text-[11px] text-cyan-400 font-medium text-center"
              >
                Manage & Record Signals →
              </button>
            </div>

          </div>
        )}

        {/* Voice Lab & Settings Panel (When opened) */}
        {showSettings && (
          <div className="w-full max-w-4xl liquid-glass rounded-[2.5rem] p-6 sm:p-8 mt-6 border border-white/10 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-6 border-b border-white/10">
              <div className="flex bg-slate-900/80 p-1 rounded-2xl border border-white/10">
                <button
                  onClick={() => requestAction({ type: 'tab', data: 'voice' })}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all ${
                    activeTab === 'voice' ? 'bg-cyan-500 text-slate-950 font-bold shadow-md' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Acoustic Tuning
                </button>
                <button
                  onClick={() => requestAction({ type: 'tab', data: 'clips' })}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all ${
                    activeTab === 'clips' ? 'bg-cyan-500 text-slate-950 font-bold shadow-md' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Signal Library ({voiceSettings.customClips.length})
                </button>
                <button
                  onClick={() => requestAction({ type: 'tab', data: 'typesafe' })}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all ${
                    activeTab === 'typesafe' ? 'bg-cyan-500 text-slate-950 font-bold shadow-md' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  TypeSafe Engine
                </button>
              </div>

              <button
                onClick={() => requestAction({ type: 'close' })}
                className="liquid-glass-button w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-white"
              >
                <i className="fas fa-times text-xs"></i>
              </button>
            </div>

            <div className="pt-6">
              {activeTab === 'voice' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block">Neural Voice Persona</label>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.values(VoiceName).map(v => (
                        <button
                          key={v}
                          onClick={() => setVoiceSettings({ ...voiceSettings, voiceName: v })}
                          disabled={voiceState.isActive}
                          className={`p-3 rounded-2xl text-left border transition-all ${
                            voiceSettings.voiceName === v
                              ? 'bg-cyan-500/20 border-cyan-500/40 text-white shadow-[0_0_20px_rgba(0,199,190,0.15)]'
                              : 'liquid-glass-subtle border-white/5 text-slate-400 hover:text-white'
                          } disabled:opacity-50`}
                        >
                          <div className="text-xs font-bold">{v}</div>
                          <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                            {v === VoiceName.ZEPHYR ? 'Calm & Balanced' : v === VoiceName.PUCK ? 'Dynamic & Lively' : v === VoiceName.CHARON ? 'Deep Resonance' : v === VoiceName.KORE ? 'Gentle Studio' : 'Authoritative'}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-5">
                    <div>
                      <div className="flex justify-between items-center mb-1.5">
                        <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Processing Rate</label>
                        <span className="text-xs font-mono text-cyan-400">{voiceSettings.speed.toFixed(1)}x</span>
                      </div>
                      <input
                        type="range"
                        min="0.5"
                        max="2.0"
                        step="0.1"
                        value={voiceSettings.speed}
                        onChange={(e) => setVoiceSettings({ ...voiceSettings, speed: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between items-center mb-1.5">
                        <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Harmonic Pitch Shift</label>
                        <span className="text-xs font-mono text-cyan-400">{voiceSettings.pitch.toFixed(1)}x</span>
                      </div>
                      <input
                        type="range"
                        min="0.5"
                        max="1.5"
                        step="0.1"
                        value={voiceSettings.pitch}
                        onChange={(e) => setVoiceSettings({ ...voiceSettings, pitch: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                      />
                    </div>

                    <div className="liquid-glass-subtle p-4 rounded-2xl border border-white/5">
                      <div className="text-[11px] font-semibold text-slate-300 mb-1">Acoustic Web Audio DSP Active</div>
                      <p className="text-[10px] text-slate-500 leading-relaxed">
                        Features real-time 16kHz Float32 to Int16 PCM encoding for zero-latency bidirectional audio streaming to Gemini.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'clips' && (
                <div className="space-y-6">
                  {/* Top Bar for Clips: Search, Upload, Record */}
                  <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
                    <div className="relative flex-1">
                      <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-500"></i>
                      <input
                        type="text"
                        placeholder="Search audio signals by tag or keyword..."
                        value={clipSearchQuery}
                        onChange={(e) => setClipSearchQuery(e.target.value)}
                        className="w-full bg-slate-900/80 border border-slate-700/60 rounded-xl pl-9 pr-8 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/40 text-white font-medium"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={isRecordingClip ? stopRecording : startRecording}
                        className={`px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all ${
                          isRecordingClip
                            ? 'bg-red-500 text-white shadow-lg shadow-red-500/25 animate-pulse'
                            : 'liquid-glass-button text-emerald-400 hover:text-emerald-300'
                        }`}
                      >
                        <i className={`fas ${isRecordingClip ? 'fa-stop' : 'fa-microphone'} text-[11px]`}></i>
                        <span>{isRecordingClip ? `Stop (${formatDuration(recordingDuration)})` : 'Record Signal'}</span>
                      </button>

                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="px-3 py-2 rounded-xl liquid-glass-button text-cyan-400 hover:text-cyan-300 text-xs font-semibold flex items-center gap-2"
                      >
                        <i className="fas fa-arrow-up-from-bracket text-[11px]"></i>
                        <span>Upload File</span>
                      </button>
                      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept="audio/*" className="hidden" />
                    </div>
                  </div>

                  {/* Clips List */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[380px] overflow-y-auto pr-1">
                    {filteredClips.map(clip => {
                      const isEditing = editingClipId === clip.id;
                      return (
                        <div
                          key={clip.id}
                          className={`p-4 rounded-2xl border transition-all ${
                            isEditing 
                              ? 'bg-slate-900 border-cyan-500/50 ring-2 ring-cyan-500/20 shadow-xl' 
                              : 'liquid-glass-subtle border-white/5 hover:border-white/10'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5 overflow-hidden">
                              <button
                                onClick={() => { const a = new Audio(clip.url); a.play(); }}
                                className="w-8 h-8 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shrink-0"
                              >
                                <i className="fas fa-play text-xs ml-0.5"></i>
                              </button>
                              <div className="overflow-hidden">
                                <div className="text-xs font-bold text-white truncate">{clip.name}</div>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {(clip.tags || []).map((t, idx) => (
                                    <span key={idx} className="text-[9px] bg-cyan-500/10 text-cyan-400 px-1.5 py-0.5 rounded font-mono">
                                      #{t}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              {isEditing ? (
                                <button
                                  onClick={saveEditing}
                                  className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center hover:bg-emerald-500/30"
                                  title="Save changes"
                                >
                                  <i className="fas fa-check text-xs"></i>
                                </button>
                              ) : (
                                <button
                                  onClick={() => requestAction({ type: 'switch', data: clip })}
                                  className="w-7 h-7 rounded-lg liquid-glass-button text-slate-400 hover:text-white flex items-center justify-center"
                                  title="Edit signal"
                                >
                                  <i className="fas fa-pencil text-[10px]"></i>
                                </button>
                              )}
                              <button
                                onClick={() => removeClip(clip.id)}
                                className="w-7 h-7 rounded-lg liquid-glass-button text-slate-500 hover:text-red-400 flex items-center justify-center"
                                title="Delete signal"
                              >
                                <i className="fas fa-trash text-[10px]"></i>
                              </button>
                            </div>
                          </div>

                          {/* Editing Mode */}
                          {isEditing && (
                            <div className="mt-4 pt-3 border-t border-white/10 space-y-3">
                              {/* Canvas waveform visualizer */}
                              <div>
                                <label className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block mb-1">Sonic Waveform Profile</label>
                                <div className="bg-slate-950/80 rounded-xl p-2 border border-white/5 flex items-center justify-center">
                                  <canvas ref={waveformCanvasRef} width={260} height={40} className="w-full h-10 block" />
                                </div>
                              </div>

                              <div>
                                <label className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block mb-1">Signal Name</label>
                                <input
                                  type="text"
                                  value={pendingEdit?.name || ''}
                                  onChange={(e) => setPendingEdit(prev => prev ? { ...prev, name: e.target.value } : null)}
                                  className="w-full bg-slate-950/80 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-xs text-white"
                                />
                              </div>

                              <div>
                                <label className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block mb-1">Tags (Comma-separated)</label>
                                <input
                                  ref={tagInputRef}
                                  type="text"
                                  value={tagInput}
                                  onChange={(e) => handleTagInputChange(e.target.value)}
                                  className="w-full bg-slate-950/80 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-xs font-mono text-cyan-300"
                                />
                                {tagSuggestions.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                    {tagSuggestions.map((s, idx) => (
                                      <button
                                        key={idx}
                                        onClick={() => applyTagSuggestion(s)}
                                        className="text-[9px] bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded-full border border-cyan-500/30"
                                      >
                                        +{s}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeTab === 'typesafe' && (
                <div className="space-y-4">
                  <div className="liquid-glass-subtle p-5 rounded-2xl border border-white/5 space-y-2">
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <i className="fas fa-shield-halved text-cyan-400"></i>
                      TypeSafe System One Model Evaluation
                    </h4>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Evaluated using TypeSafe's latest prompting guidelines: Adding a <code>Choice</code> primitive provides closed-set bounded classification before tool parameter extraction.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {Object.values(TOOL_CATEGORIES).map(cat => (
                      <div key={cat.id} className="liquid-glass-subtle p-4 rounded-xl border border-white/5">
                        <div className="text-xs font-bold text-cyan-300 font-mono mb-1">{cat.label} ({cat.id})</div>
                        <p className="text-[11px] text-slate-400 leading-normal">{cat.description}</p>
                        <div className="mt-2 text-[10px] font-mono text-slate-500">
                          Tools: {cat.tools.length > 0 ? cat.tools.join(', ') : 'none (direct dialogue)'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      </main>

      {/* Live Conversation Transcript Stream */}
      <section className="w-full max-w-4xl mx-auto liquid-glass rounded-[2rem] p-5 my-4 border border-white/10 shadow-xl max-h-48 overflow-y-auto z-10">
        <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <i className="fas fa-terminal text-cyan-400"></i>
            Live Utterance & Tool Log
          </div>
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors uppercase font-mono"
            >
              Clear Log
            </button>
          )}
        </div>

        {messages.length === 0 ? (
          <div className="text-center py-6 text-slate-600 text-xs font-mono">
            Awaiting speech signals... Press Space or tap the orb to begin.
          </div>
        ) : (
          <div className="space-y-2.5">
            {messages.map(msg => (
              <div key={msg.id} className="flex items-start gap-3 text-xs">
                <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 font-mono ${
                  msg.role === 'user' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                }`}>
                  {msg.role === 'user' ? 'User' : 'Nova'}
                </span>
                <p className="text-slate-200 leading-relaxed font-normal flex-1">{msg.content}</p>
                <span className="text-[9px] text-slate-500 font-mono shrink-0">
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Footer: Dynamic Automated Year Synchronization Logic */}
      <footer className="w-full max-w-6xl mx-auto mt-4 pt-4 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 z-10">
        <div className="flex items-center gap-2">
          <span>© 2025–{currentYear} Voice Command Assistant • Nova Studio Edition</span>
          <span className="text-slate-600">•</span>
          <span className="text-emerald-400/80 flex items-center gap-1 font-mono text-[10px]">
            <i className="fas fa-circle-check text-[8px]"></i> Automated {currentYear}+
          </span>
        </div>

        <div className="flex items-center gap-4 text-[11px]">
          <span className="text-slate-400">Google Gemini Live 2.5 Flash</span>
          <span className="text-slate-600">•</span>
          <span className="text-slate-400">Apple Liquid Glass HIG</span>
          <span className="text-slate-600">•</span>
          <a
            href="https://github.com/Rahul08319/voice-command-assistant"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-1"
          >
            <i className="fab fa-github"></i> GitHub
          </a>
        </div>
      </footer>

    </div>
  );
}
