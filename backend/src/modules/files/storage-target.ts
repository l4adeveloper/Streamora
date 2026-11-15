import { createHash } from "node:crypto";
import type { EnvironmentConfig } from "../../config/environment";

export type StorageTarget =
  | { driver: "local"; directory: string }
  | { driver: "s3"; bucket: string; region: string };
export function configuredStorage(
  config: Pick<EnvironmentConfig, "files">,
): StorageTarget {
  return config.files?.driver === "local"
    ? { driver: "local", directory: config.files.localDirectory! }
    : {
        driver: "s3",
        bucket: config.files?.bucket ?? "",
        region: config.files?.region ?? "ap-southeast-1",
      };
}
export function locationId(target: StorageTarget) {
  // JSONB may reorder object keys; hash an explicit tuple for a stable identity.
  const fields =
    target.driver === "local"
      ? ["local", target.directory]
      : ["s3", target.bucket, target.region];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
