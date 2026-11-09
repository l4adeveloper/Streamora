export type MediaCapability = "PUBLISH" | "SUBSCRIBE";
export interface JoinClassMediaRequest {
  participationId: string;
  clientId: string;
  requestId: string;
  deviceLabel?: string;
}
export interface JoinClassMediaResponse {
  requestId: string;
  connectionId: string;
  participantToken: string;
  participantId: string;
  expiresIn: number;
  expiresAt: string;
  capabilities: MediaCapability[];
}
export interface ClassMediaState {
  connected: boolean;
  micEnabled: boolean | null;
  cameraEnabled: boolean | null;
  checkedAt: string | null;
}
export interface ClassMediaHeartbeatRequest {
  requestId: string;
  participationId: string;
  clientId: string;
  connected: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
}
