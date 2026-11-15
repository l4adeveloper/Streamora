import type { VideoPolicy } from "./video-policy";
import type { parseProbe } from "./video-probe";

export const VIDEO_MANAGED_ENCODER = Symbol("VIDEO_MANAGED_ENCODER");

export interface EncodeRequest {
  jobId: string;
  attempt: number;
  source: string;
  destination: string;
  policy: VideoPolicy;
}

// Cloud adapters own provider requests, identity checks and status mapping.
// The worker keeps the same durable queue, leases, retries and HLS validation.
export interface ManagedVideoEncoder {
  probe(input: string): Promise<ReturnType<typeof parseProbe>>;
  // Definitive rejection uses VideoError; an uncertain handoff must be recovered.
  start(request: EncodeRequest): Promise<string>;
  status(
    id: string,
    request: EncodeRequest,
  ): Promise<{
    state: "PROCESSING" | "COMPLETE" | "FAILED";
    progressPercent?: number;
  }>;
  recover(jobId: string, attempt: number): Promise<string | undefined>;
  close(): void;
}
