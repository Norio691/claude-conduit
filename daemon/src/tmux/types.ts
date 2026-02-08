export interface TmuxSession {
  name: string;
  attached: boolean;
  created: Date;
}

export interface AttachResult {
  wsUrl: string;
  tmuxSession: string;
  existed: boolean;
}
