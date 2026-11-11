import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { INestApplication } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { useAzureSocketIO } from "@azure/web-pubsub-socket.io";
import type { ServerOptions } from "socket.io";
import {
  ConfigurationError,
  type EnvironmentConfig,
} from "../config/environment";

type AzureSocketServer = Parameters<typeof useAzureSocketIO>[0];
// The extension relies on private Engine.IO and Socket.IO APIs. Resolve its
// own compatible version instead of the versions used by the local adapter.
const requireFromAzureSdk = createRequire(
  require.resolve("@azure/web-pubsub-socket.io"),
);

export class AzureIoAdapter extends IoAdapter {
  private server?: AzureSocketServer;

  constructor(app: INestApplication) {
    super(app);
  }

  override createIOServer(_port: number, options?: Partial<ServerOptions>) {
    // The SDK needs an HTTP server to attach to. Azure owns public socket
    // connections, so this server never listens and leaves the Nest API alone.
    const { Server } = requireFromAzureSdk("socket.io") as {
      Server: new (
        server: ReturnType<typeof createServer>,
        options: Partial<ServerOptions>,
      ) => AzureSocketServer;
    };
    return (this.server ??= new Server(createServer(), {
      ...options,
      serveClient: false,
    }));
  }

  async connect(config: NonNullable<EnvironmentConfig["azureRealtime"]>) {
    const secrets = new SecretsManagerClient({ region: config.region });
    try {
      const { SecretString } = await secrets.send(
        new GetSecretValueCommand({ SecretId: config.secretId }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (!SecretString || !this.server) throw new Error();
      const { useAzureSocketIO } = await import("@azure/web-pubsub-socket.io");
      const options = {
        hub: "classroom",
        connectionString: SecretString.trim(),
        // The Azure extension serializes its options in DEBUG logs.
        toJSON: () => ({ hub: "classroom" }),
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          useAzureSocketIO(this.server, options),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(reject, 30000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      throw new ConfigurationError(
        "SERVICE_UNAVAILABLE: Không thể kết nối Azure Web PubSub. Kiểm tra hub và cấu hình AWS Secrets Manager.",
      );
    } finally {
      secrets.destroy();
    }
  }
}
