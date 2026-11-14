import {
  CreateJobCommand,
  GetJobCommand,
  ListJobsCommand,
  MediaConvertClient,
  type JobSettings,
  type Job,
} from "@aws-sdk/client-mediaconvert";
import { createHash } from "node:crypto";
import type { VideoConfig } from "./video-config";
import { VideoError, type VideoPolicy } from "./video-policy";

export function mediaConvertSettings(
  input: string,
  destination: string,
  policy: VideoPolicy,
): JobSettings {
  return {
    TimecodeConfig: { Source: "ZEROBASED" },
    Inputs: [
      {
        FileInput: input,
        VideoSelector: { Rotate: "AUTO" },
        TimecodeSource: "ZEROBASED",
        ...(policy.audio
          ? {
              AudioSelectors: {
                Audio: { DefaultSelection: "DEFAULT" as const },
              },
            }
          : {}),
      },
    ],
    OutputGroups: [
      {
        Name: "HLS",
        OutputGroupSettings: {
          Type: "HLS_GROUP_SETTINGS",
          HlsGroupSettings: {
            Destination: destination + "/hls/master",
            SegmentLength: 4,
            MinSegmentLength: 0,
            OutputSelection: "MANIFESTS_AND_SEGMENTS",
            DirectoryStructure: "SINGLE_DIRECTORY",
          },
        },
        Outputs: policy.renditions.map((r) => ({
          NameModifier: `_${r.id}`,
          ContainerSettings: { Container: "M3U8", M3u8Settings: {} },
          VideoDescription: {
            Width: r.width,
            Height: r.height,
            ScalingBehavior: "FIT_NO_UPSCALE",
            CodecSettings: {
              Codec: "H_264",
              H264Settings: {
                Bitrate: r.bitrate,
                RateControlMode: "CBR",
                CodecProfile: "HIGH",
                CodecLevel: "AUTO",
                FramerateControl: "SPECIFIED",
                ParControl: "SPECIFIED",
                ParNumerator: 1,
                ParDenominator: 1,
                FramerateNumerator: Math.round(policy.fps * 1000),
                FramerateDenominator: 1000,
                GopSize: 4,
                GopSizeUnits: "SECONDS",
                GopClosedCadence: 1,
                SceneChangeDetect: "DISABLED",
              },
            },
          },
          ...(policy.audio
            ? {
                AudioDescriptions: [
                  {
                    AudioSourceName: "Audio",
                    CodecSettings: {
                      Codec: "AAC" as const,
                      AacSettings: {
                        Bitrate: 128000,
                        SampleRate: 48000,
                        CodingMode: "CODING_MODE_2_0" as const,
                      },
                    },
                  },
                ],
              }
            : {}),
        })),
      },
      {
        Name: "Thumbnail",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: {
            Destination: destination + "/thumbnails/poster",
          },
        },
        Outputs: [
          {
            NameModifier: "_capture",
            ContainerSettings: { Container: "RAW" },
            VideoDescription: {
              Width: 320,
              ScalingBehavior: "FIT_NO_UPSCALE",
              CodecSettings: {
                Codec: "FRAME_CAPTURE",
                FrameCaptureSettings: {
                  FramerateNumerator: 1,
                  FramerateDenominator: 10,
                  MaxCaptures: 1,
                  Quality: 80,
                },
              },
            },
          },
        ],
      },
    ],
  };
}
export class MediaConvertEncoder {
  readonly client: MediaConvertClient;
  constructor(readonly config: VideoConfig) {
    this.client = new MediaConvertClient({
      region: config.region,
      maxAttempts: 2,
    });
  }
  async submit(jobId: string, attempt: number, settings: JobSettings) {
    const result = await this.client.send(
      new CreateJobCommand({
        Role: this.config.roleArn,
        Queue: this.config.queueArn,
        Settings: settings,
        ClientRequestToken: createHash("sha256")
          .update(`${jobId}:${attempt}`)
          .digest("hex"),
        UserMetadata: {
          project: "streamora",
          jobId,
          attemptNo: String(attempt),
        },
        StatusUpdateInterval: "SECONDS_60",
      }),
    );
    if (!result.Job?.Id) throw new VideoError("SUBMISSION_UNCERTAIN");
    return result.Job.Id;
  }
  async inspect(id: string) {
    return (await this.client.send(new GetJobCommand({ Id: id }))).Job;
  }
  async reconcile(jobId: string, attempt: number): Promise<Job | undefined> {
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.client.send(
        new ListJobsCommand({
          Queue: this.config.queueArn,
          Order: "DESCENDING",
          MaxResults: 20,
          NextToken: token,
        }),
      );
      const match =
        result.Jobs?.filter(
          (j) =>
            j.UserMetadata?.project === "streamora" &&
            j.UserMetadata.jobId === jobId &&
            j.UserMetadata.attemptNo === String(attempt),
        ) ?? [];
      if (match.length > 1) throw new VideoError("SUBMISSION_UNCERTAIN");
      if (match[0]?.Id) return this.inspect(match[0].Id);
      token = result.NextToken;
      if (!token) break;
    }
    // Absence in ListJobs is not proof that a previous CreateJob failed.
    return undefined;
  }
  verify(
    provider: Job,
    jobId: string,
    attempt: number,
    input: string,
    destination: string,
    policy: VideoPolicy,
  ) {
    if (
      provider.UserMetadata?.project !== "streamora" ||
      provider.UserMetadata.jobId !== jobId ||
      provider.UserMetadata.attemptNo !== String(attempt) ||
      provider.Role !== this.config.roleArn ||
      provider.Queue !== this.config.queueArn ||
      !provider.Arn?.startsWith(
        `arn:aws:mediaconvert:${this.config.region}:${this.config.accountId}:jobs/`,
      ) ||
      provider.Settings?.Inputs?.[0]?.FileInput !== input ||
      provider.Settings?.OutputGroups?.[0]?.OutputGroupSettings
        ?.HlsGroupSettings?.Destination !==
        destination + "/hls/master"
    )
      throw new VideoError("PROVIDER_MISMATCH");
    const outputs = provider.Settings.OutputGroups[0].Outputs ?? [];
    if (
      outputs.length !== policy.renditions.length ||
      policy.renditions.some(
        (r) =>
          !outputs.some(
            (o) =>
              o.VideoDescription?.Width === r.width &&
              o.VideoDescription.Height === r.height,
          ),
      )
    )
      throw new VideoError("PROVIDER_MISMATCH");
  }
}
