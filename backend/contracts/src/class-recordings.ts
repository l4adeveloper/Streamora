export type ClassRecordingStatus = "RECORDING" | "SAVING" | "SAVED" | "FAILED";
export type ClassRecordingCameraPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
export interface ClassRecordingLayout {
  /** Corner of the presenter's camera over the shared screen. */
  cameraPosition: ClassRecordingCameraPosition;
  /** The presenter can hide the camera so it never covers screen content. */
  cameraVisible: boolean;
}
export interface ClassRecordingPresenter {
  userId: string;
  fullName: string;
  /** IVS participant of the screen share; matches MediaPeer.id on clients. */
  participantId: string | null;
}
export interface ClassRecording {
  id: string;
  sessionId: string;
  status: ClassRecordingStatus;
  recorderId: string;
  recorderName: string;
  startedAt: string;
  stoppedAt: string | null;
  fileId: string | null;
  layout: ClassRecordingLayout;
  /** The single screen share kept while recording, if anyone is sharing. */
  presenter: ClassRecordingPresenter | null;
  version: number;
}
export interface ClassRecordingStateResponse {
  /** Latest recording that is still recording or being saved. */
  recording: ClassRecording | null;
  canRecord: boolean;
  groupId: string | null;
  title: string;
}
export interface ClassRecordingResponse {
  recording: ClassRecording;
}
export interface StartClassRecordingRequest {
  participationId: string;
}
export type UpdateClassRecordingLayoutRequest = Partial<ClassRecordingLayout>;
export interface CompleteClassRecordingRequest {
  fileId: string;
}
