# T18 — GCS replicas (in progress)

## Implemented: completed VOD replication

`VideoReplicationWorker` discovers published READY MediaConvert/IVS outputs in SQL
every 15 seconds, and creates one durable replica per job/version and destination
bucket. It is disabled unless `VIDEO_REPLICATION_ENABLED=true`.

The worker claims a 60 second lease, renews it every 15 seconds, streams media from
S3 to GCS with checksum validation, verifies size/MD5, then publishes child
playlists before the master. Keys remain identical to S3. Playlists must stay
inside the asset prefix; unfinished live playlists, cycles and remote references
are rejected. Only the final successful copy changes the replica to READY.

Failed jobs retry with exponential backoff, up to 8 claimed attempts. Expired
leases can be reclaimed after restart. After exhausting attempts an operator must
investigate and reset the job; there is no public retry endpoint yet.

Configuration for the lead to deploy after cloud resources are created:

```dotenv
VIDEO_REPLICATION_ENABLED=false
VIDEO_GCS_REPLICA_BUCKET=<private Standard bucket>
VIDEO_GCS_PROJECT_ID=project-b386f453-be2f-4bbc-aa0
GOOGLE_APPLICATION_CREDENTIALS=<absolute path to ADC credentials config>
VIDEO_GCS_CDN_DOMAIN=136-68-88-96.sslip.io
VIDEO_GCS_CDN_KEY_NAME=streamora-t18-cdn-key-v2
VIDEO_GCS_CDN_SIGNING_SECRET_ID=streamora/t18-gcs-cdn-signing
```

Use Application Default Credentials with the official `@google-cloud/storage`
SDK. Do not put credentials in the frontend, Git, or screenshots. No Google
credentials are needed while the worker is disabled. No source video is buffered
in full or written to EC2 scratch as part of copying media.

Migration: `20261116000300_video_replicas`. No cloud service is created by the
migration or by API startup.

## Cloud setup and verification

Cloud setup verified on 2026-11-16: private Standard bucket
`streamora-video-replica-b386f453` in `asia-southeast1`; service account
`streamora-t18-replicator@project-b386f453-be2f-4bbc-aa0.iam.gserviceaccount.com`
has Storage Object User on that bucket. AWS WIF pool `streamora-aws`, provider
`streamora-aws-services` (project number `718247467913`) permits the subject
`arn:aws:iam::586481704097:user/streamora-developer` to impersonate that account.
The downloaded external-account ADC configuration successfully authenticated
using local AWS environment credentials and listed the bucket. This verifies
token exchange and list access. On 2026-11-17, a unique small diagnostic object
was written, downloaded and compared, then deleted successfully using WIF.
On 2026-11-17, a four-second synthetic HLS video (four media objects, two
playlists) was uploaded under a unique UUID prefix to the S3 output bucket and
copied with the production replication planner/storage adapters into GCS.
Checksum validation passed. Edge headless decoded the video with signed Cloud
CDN segments and application-origin CORS, using intercepted diagnostic playlist
responses (no application deployment). All test objects were deleted from both
buckets. This does not verify deployed worker discovery, resolver or failover.
The lead must install the ADC configuration at a deployment-local path and set
`GOOGLE_APPLICATION_CREDENTIALS` accordingly, with AWS credentials and
`AWS_REGION` available to the process. The Windows download path is not a server
configuration value.

Cloud CDN origin `streamora-t18-video-origin` now uses the replica bucket and
load balancer `streamora-t18-video-lb`. Signed request key name:
`streamora-t18-cdn-key-v2`; its value is held by the user for secure lead handoff.
The original `streamora-t18-cdn-key` was removed successfully in Cloud Shell
after replacement and verification on 2026-11-17.
The CDN fill identity `service-718247467913@cloud-cdn-fill.iam.gserviceaccount.com`
has bucket-level Storage Object Viewer. Signed cache maximum age is 3600 seconds,
negative caching is disabled, and serve-while-stale is disabled.
The static IPv4 `136.68.88.96` is reserved as `streamora-t18-video-ip`;
HTTPS frontend references `streamora-t18-video-cert` for
`136-68-88-96.sslip.io`. Certificate is ACTIVE in the 2026-11-17 screenshot;
an HTTPS request with normal certificate validation succeeded and returned 403
for the unsigned root request. On 2026-11-17 both Google CLI (user Cloud Shell)
and local Node.js HMAC-SHA1 signed URL probes returned 200 for a small private
diagnostic object. The local probe verified exact content and application-origin
CORS; unsigned and expired URLs returned 403. Probe objects were deleted.
Initial v2 probes immediately after configuration update returned 403; later
probes passed without changing the local signer.
CORS was applied for GET/HEAD from
`https://18-138-205-52.sslip.io`. The diagnostic HLS browser smoke passed, as
described above. Existing HTTP frontends use separate ephemeral IPs.

## VOD playback source resolver

`POST /recordings/:id/playback` accepts `mode: VOD`, optional
`failedSourceId`, `preferredSourceId`, and `positionSeconds`. It reauthorizes the
viewer before reading the published version. CloudFront is preferred initially;
GCS is eligible only when the same job/version snapshot is READY with a positive
object count and successful sync timestamp. Signed master HEAD probes have a
2.5-second timeout and short per-version health caches. Client failure hints do
not change global source health. Renewal retains the current healthy source.

Playlists are rewritten at `/recording-media/:id/:jobId/:sourceId/*path` using a
60-second HttpOnly grant scoped to that viewer, recording, version and source.
Each playlist request rechecks membership, publication and replica readiness.
Segments use individual 15-minute CDN signed URLs. Previously issued segment
URLs remain valid until expiry; revocation prevents new grants/playlists.
`GET /recordings/:id/thumbnail` returns a signed thumbnail from an available
source. `LIVE_DVR` now resolves IVS HLS independently of published VOD and
returns a safe `readyThroughSeconds` watermark, as described below.

The backend loads the GCS signing key as plain base64url text from AWS Secrets
Manager in the configured AWS region. On 2026-11-17 the secret
`streamora/t18-gcs-cdn-signing` was created in `ap-northeast-1`, account
`586481704097`, with `aws/secretsmanager` encryption and rotation disabled.
Inline policy `streamora-t18-signing-secret` grants `streamora-developer` only
`secretsmanager:GetSecretValue` on
`arn:aws:secretsmanager:ap-northeast-1:586481704097:secret:streamora/t18-gcs-cdn-signing-??????`.
An actual SDK read succeeded and matched the verified v2 key without logging it.
The production `VideoDelivery.gcsSignedObjectFactory` loaded the secret and
produced the expected signature; a signed HEAD for an intentionally absent
object returned 404, as expected. Successful keys are cached
until process restart; rotate configuration and restart the API when switching
key versions. Never deploy the local diagnostic key-file path as a setting.

`GET /internal/assets/:fileId/replicas` and `/admin/video-replicas` expose technical
status to global ADMIN accounts only. Ordinary viewers cannot access the API.

The local HLS browser regression passed on 2026-11-17, including switching
between independent primary/replica test HTTP paths, restoring the latest seek,
manual quality, playback rate, volume and paused state, and stopping automatic
switching when both paths fail. These are local browser fixtures, not a deployed
CloudFront-to-Cloud-CDN failure demonstration.

## Additional implementation on 2026-11-17 (local verification)

`StorageReplicationWorker` discovers available S3 raw files and IVS recordings
with registered source locations. Migration `20261117000100_storage_replicas`
adds durable work state, database leases, heartbeat, restart recovery and
exponential backoff (eight consecutive failed claims). Successful refreshes
reset the attempt counter. RAW and LIVE_DVR have independent work lanes, so a
large raw upload does not block DVR refreshes. Both use the existing
`VIDEO_REPLICATION_ENABLED` flag.

Raw files, including empty files, are streamed and size/checksum verified under
`replicas/raw/<fileId>/object`. This adds backup replication; the raw download
endpoint still uses its original source. Local filesystem files are excluded.
The deployment identity needs GetObject on every registered S3 source bucket.

LIVE_DVR media uses `replicas/live/<recordingId>/...`. Already verified segments
with matching source ETag, size and version are reused. Changed media is rejected
instead of overwriting bytes used by an earlier snapshot. The entire playlist
tree is committed atomically in SQL after media copies finish. A failed refresh
preserves the last safe snapshot and watermark. ENDLIST on all media playlists
completes the replica. Prefix changes, timeline regression, playlist rewrites
and deleted/failed recordings fail closed.

Supported input is a complete append-only event timeline starting at media
sequence zero with one multivariant master. Sliding windows, encrypted HLS and
partial/low-latency HLS are rejected rather than reporting incorrect DVR times.
Actual IVS output must still be checked during deployed acceptance.

Live playlists recheck recording access on every request using scoped HttpOnly
grants. GCS segments use signed Cloud CDN URLs; primary IVS segments use S3
presigned URLs. Source health uses bounded HEAD probes. A requested position
outside a replica's committed watermark excludes that source. The recording
page can play LIVE_DVR before a file exists and switches to VOD after SAVED.

Region preference is configured by the lead, for example:

```dotenv
VIDEO_SOURCE_REGION_PREFERENCES={"ASIA":"gcs","EUROPE":"cloudfront"}
```

The browser sends a coarse `viewerRegion` based on its timezone area (`ASIA`,
`EUROPE`, `AMERICA`, `AFRICA`, `AUSTRALIA`, `PACIFIC`). API clients may supply
another configured region code. This is a routing hint, not geolocation or an
authorization signal. Unmapped VOD regions retain CloudFront priority;
LIVE_DVR prefers primary S3 unless GCS is configured for that region. Renewal
retains a healthy current source. Health, readiness and requested playback
position always take priority over the region hint.

ADMIN endpoints expose raw status at `GET /internal/assets/:fileId/replicas`
(`storageReplicas`) and DVR status at
`GET /internal/assets/:recordingId/replicas/live`. They omit snapshot contents,
source locations and signing credentials.

No new cloud resource is required by this code. The lead applies the migration
before starting the updated API and verifies source IAM plus GET/HEAD CORS for
the application origin on the IVS recording bucket. If an existing permission
or CORS rule is missing, the user performs that cloud change with screenshot
checks; the lead handles deployment.

Deployment follow-up on 2026-11-17: the server passed WIF list/write/read/delete
checks and reported 29 RAW plus three LIVE_DVR replicas READY. Ten legacy DVR
rows failed because their SAVED recordings referenced DELETED files. Discovery
now excludes those recordings and retires unleased invalid work (including
exhausted retries) with `completed=true`, status FAILED and
`REPLICA_SOURCE_INVALID`. Source invalidation during a copy uses that same
terminal error; actual lease loss remains `LEASE_LOST`. This change needs no
migration and does not delete stored media or modify completed READY replicas.
The fix passed TypeScript, eight focused unit tests and the SQL regression that
covers deleted recordings, exhausted work and protection of active leases.

## Still required before T18 acceptance

- Install WIF configuration and signing secret in the deployment environment;
  verify the deployed worker discovers and completes a real published version.
- Verify real raw replication and active IVS segment replication, advancing
  watermark, seeking and source failover after deployment.
- Configure and verify region preference with deployed sources.
- Coordinate retention and cleanup of old S3/GCS versions. The worker only
  discovers currently published versions; it does not delete replicas.
- CloudFront and Cloud CDN end-to-end authorization and failure demonstration.

User performs cloud configuration one step at a time with screenshot checks;
lead performs deployment. Do not require the user to deploy EC2.

## Checks

Local verification on 2026-11-17: backend/frontend TypeScript and Prisma schema
validation passed; 15 focused unit checks and four SQL integration checks passed.
The Edge headless regression passed, including unfinished EVENT playlist playback
without a recording fileId and seeking backward. Its first run failed an earlier
VOD buffer reuse assertion; a standalone rerun passed the full regression. These
are local fixtures, not proof of deployed IVS-to-GCS playback.

```bash
npx tsc -p backend/tsconfig.json
node --test backend/test/cloud-cdn-signed-url.test.cjs backend/test/recording-source-health.test.cjs
node --test backend/test/video-replication.test.cjs
node --test backend/test/storage-replication.test.cjs
node --test --test-force-exit backend/test/integration/storage-replicas.test.cjs
node --test --test-force-exit --test-concurrency=1 backend/test/integration/video-replicas.test.cjs backend/test/integration/recording-sources.test.cjs backend/test/integration/recording-playback.test.cjs
npm run typecheck --workspace=@streamora/web
node --test --test-force-exit backend/test/frontend/video-pipeline-ui.test.cjs
```

Automated API/worker tests use fake storage or isolated PGlite. The real cloud
smoke described above is separate and does not establish full deployed failover.
