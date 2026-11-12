"use client";
import type { ClassRecordingLayout } from "@streamora/contracts";

/** What the recording shows at a given moment; rebuilt as the room changes. */
export interface RecorderScene {
  screen: { key: string; name: string; stream: MediaStream } | null;
  /** The presenter's camera, drawn in a corner over the shared screen. */
  presenterCamera: { key: string; stream: MediaStream } | null;
  layout: ClassRecordingLayout;
  /** Camera grid used while nobody shares a screen. */
  tiles: { key: string; name: string; stream?: MediaStream; camera: boolean }[];
  /** Every audio source to mix: mics of everyone plus shared-screen audio. */
  audio: MediaStreamTrack[];
}

const WIDTH = 1280,
  HEIGHT = 720,
  FPS = 30;
const MIME_TYPES = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function recordingMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return null;
  const fileType = mimeType.split(";")[0];
  return { mimeType, fileType, extension: fileType === "video/mp4" ? "mp4" : "webm" };
}

export function recordingSupported() {
  return (
    typeof window !== "undefined" &&
    !!recordingMime() &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    typeof AudioContext !== "undefined"
  );
}

function contain(width: number, height: number, boxW: number, boxH: number) {
  const scale = Math.min(boxW / width, boxH / height);
  return { w: width * scale, h: height * scale };
}
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
// Fills the box, cropping the overflow like CSS object-fit: cover.
function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
  const sw = w / scale,
    sh = h / scale;
  ctx.drawImage(
    video,
    (video.videoWidth - sw) / 2,
    (video.videoHeight - sh) / 2,
    sw,
    sh,
    x,
    y,
    w,
    h,
  );
}

/**
 * Records the classroom in this browser: draws the shared screen (or a camera
 * grid) on a canvas, mixes all remote and local audio with Web Audio, and
 * encodes both with MediaRecorder. Mixed audio never goes to the speakers.
 */
export class ClassRecorder {
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host = document.createElement("div");
  private readonly videos = new Map<string, HTMLVideoElement>();
  private readonly audioContext = new AudioContext();
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly sources = new Map<string, MediaStreamAudioSourceNode>();
  private readonly chunks: Blob[] = [];
  private readonly recorder: MediaRecorder;
  private readonly format: NonNullable<ReturnType<typeof recordingMime>>;
  private scene: RecorderScene;
  private ticker: Worker | ReturnType<typeof setInterval> | null = null;
  private stopped: Promise<Blob> | null = null;
  readonly startedAt = Date.now();

  constructor(scene: RecorderScene, onFailure: () => void) {
    const format = recordingMime();
    const ctx = this.canvas.getContext("2d");
    if (!format || !ctx) throw new Error("RECORDING_UNSUPPORTED");
    this.format = format;
    this.ctx = ctx;
    this.scene = scene;
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    // Off-screen but rendered, so browsers keep decoding the video frames.
    Object.assign(this.host.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "320px",
      height: "180px",
      overflow: "hidden",
      pointerEvents: "none",
    });
    this.host.setAttribute("aria-hidden", "true");
    document.body.append(this.host);
    this.destination = this.audioContext.createMediaStreamDestination();
    void this.audioContext.resume().catch(() => {});
    this.update(scene);
    this.draw();
    const video = this.canvas.captureStream(FPS).getVideoTracks()[0];
    const audio = this.destination.stream.getAudioTracks()[0];
    this.recorder = new MediaRecorder(new MediaStream([video, audio]), {
      mimeType: format.mimeType,
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 128_000,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.onerror = onFailure;
    this.recorder.start(1000);
    this.startTicker();
  }

  get fileType() {
    return this.format.fileType;
  }
  get extension() {
    return this.format.extension;
  }

  // Worker timers keep firing while this tab is in the background, which is
  // the normal case when the recorder is presenting another window.
  private startTicker() {
    const tick = () => this.draw();
    try {
      const source = `setInterval(() => postMessage(0), ${Math.round(1000 / FPS)});`;
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = tick;
      this.ticker = worker;
    } catch {
      this.ticker = setInterval(tick, 1000 / FPS);
    }
  }

  private video(stream: MediaStream) {
    let element = this.videos.get(stream.id);
    if (!element) {
      element = document.createElement("video");
      element.muted = true;
      element.playsInline = true;
      element.autoplay = true;
      element.width = 320;
      element.height = 180;
      element.srcObject = stream;
      this.host.append(element);
      this.videos.set(stream.id, element);
      void element.play().catch(() => {});
    }
    return element;
  }

  update(scene: RecorderScene) {
    this.scene = scene;
    const streams = new Set<string>();
    for (const stream of [
      scene.screen?.stream,
      scene.presenterCamera?.stream,
      ...scene.tiles.map((tile) => tile.stream),
    ])
      if (stream) {
        streams.add(stream.id);
        this.video(stream);
      }
    for (const [id, element] of this.videos)
      if (!streams.has(id)) {
        element.srcObject = null;
        element.remove();
        this.videos.delete(id);
      }
    // Attach each audio track once, so one voice is never mixed twice.
    const tracks = new Map(
      scene.audio
        .filter((track) => track.readyState === "live")
        .map((track) => [track.id, track]),
    );
    for (const [id, node] of this.sources)
      if (!tracks.has(id)) {
        node.disconnect();
        this.sources.delete(id);
      }
    for (const [id, track] of tracks)
      if (!this.sources.has(id)) {
        const node = this.audioContext.createMediaStreamSource(new MediaStream([track]));
        node.connect(this.destination);
        this.sources.set(id, node);
      }
  }

  private ready(stream?: MediaStream) {
    const element = stream && this.videos.get(stream.id);
    return element && element.readyState >= 2 && element.videoWidth > 0
      ? element
      : null;
  }

  private label(text: string, x: number, y: number) {
    const ctx = this.ctx;
    ctx.font = "600 18px system-ui, sans-serif";
    const width = ctx.measureText(text).width + 20;
    ctx.fillStyle = "rgba(10, 12, 20, 0.66)";
    roundedRect(ctx, x, y - 30, width, 30, 8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 10, y - 15);
  }

  private draw() {
    const ctx = this.ctx;
    ctx.fillStyle = "#0f1220";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const screen = this.scene.screen && this.ready(this.scene.screen.stream);
    if (screen) {
      const { w, h } = contain(screen.videoWidth, screen.videoHeight, WIDTH, HEIGHT);
      ctx.drawImage(screen, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
      const camera = this.scene.presenterCamera;
      const face = camera && this.scene.layout.cameraVisible && this.ready(camera.stream);
      if (face) {
        const width = Math.round(WIDTH * 0.24),
          height = Math.round((width * 9) / 16),
          margin = 24;
        const [vertical, horizontal] = this.scene.layout.cameraPosition.split("-");
        const x = horizontal === "left" ? margin : WIDTH - width - margin;
        const y = vertical === "top" ? margin : HEIGHT - height - margin;
        ctx.save();
        roundedRect(ctx, x, y, width, height, 14);
        ctx.clip();
        drawCover(ctx, face, x, y, width, height);
        ctx.restore();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.lineWidth = 3;
        roundedRect(ctx, x, y, width, height, 14);
        ctx.stroke();
      }
      return;
    }
    const tiles = this.scene.tiles.slice(0, 9);
    if (!tiles.length) return;
    const columns = Math.ceil(Math.sqrt(tiles.length)),
      rows = Math.ceil(tiles.length / columns),
      gap = 12;
    const cellW = (WIDTH - gap * (columns + 1)) / columns,
      cellH = (HEIGHT - gap * (rows + 1)) / rows;
    tiles.forEach((tile, index) => {
      const x = gap + (index % columns) * (cellW + gap),
        y = gap + Math.floor(index / columns) * (cellH + gap);
      ctx.save();
      roundedRect(ctx, x, y, cellW, cellH, 14);
      ctx.clip();
      ctx.fillStyle = "#1d2233";
      ctx.fillRect(x, y, cellW, cellH);
      const video = tile.camera ? this.ready(tile.stream) : null;
      if (video) drawCover(ctx, video, x, y, cellW, cellH);
      else {
        const radius = Math.min(cellW, cellH) * 0.18;
        ctx.fillStyle = "#6d5dfc";
        ctx.beginPath();
        ctx.arc(x + cellW / 2, y + cellH / 2, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 ${Math.round(radius)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tile.name.slice(0, 1).toUpperCase(), x + cellW / 2, y + cellH / 2);
        ctx.textAlign = "start";
      }
      ctx.restore();
      this.label(tile.name, x + 10, y + cellH - 10);
    });
  }

  /** Stops encoding and resolves with the finished file contents. */
  stop() {
    this.stopped ??= new Promise<Blob>((resolve) => {
      const finish = () => {
        this.dispose();
        resolve(new Blob(this.chunks, { type: this.format.fileType }));
      };
      if (this.recorder.state === "inactive") return finish();
      this.recorder.onstop = finish;
      this.recorder.requestData();
      this.recorder.stop();
    });
    return this.stopped;
  }

  private dispose() {
    if (this.ticker instanceof Worker) this.ticker.terminate();
    else if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const node of this.sources.values()) node.disconnect();
    this.sources.clear();
    void this.audioContext.close().catch(() => {});
    for (const element of this.videos.values()) element.srcObject = null;
    this.videos.clear();
    this.host.remove();
    for (const track of this.recorder.stream.getTracks()) track.stop();
  }
}
