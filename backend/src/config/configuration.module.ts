import { DynamicModule, Global, Module } from "@nestjs/common";
import type { EnvironmentConfig } from "./environment";

export const APP_CONFIG = Symbol("APP_CONFIG");

@Global()
@Module({})
export class ConfigurationModule {
  static forRoot(config: EnvironmentConfig): DynamicModule {
    return {
      module: ConfigurationModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
