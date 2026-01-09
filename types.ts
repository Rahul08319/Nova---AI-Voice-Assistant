
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export enum VoiceName {
  ZEPHYR = 'Zephyr',
  PUCK = 'Puck',
  CHARON = 'Charon',
  KORE = 'Kore',
  FENRIR = 'Fenrir'
}

export interface CustomClip {
  id: string;
  name: string;
  url: string;
  blob: Blob;
  description?: string;
  tags?: string[];
}

export interface VoiceSettings {
  voiceName: VoiceName;
  speed: number;
  pitch: number;
  customClips: CustomClip[];
}

export interface VoiceAssistantState {
  isActive: boolean;
  isConnecting: boolean;
  isListening: boolean;
  error: string | null;
}

export interface ToolCallResult {
  name: string;
  args: any;
  result: any;
}
