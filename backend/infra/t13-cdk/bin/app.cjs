#!/usr/bin/env node
const { App, Tags } = require("aws-cdk-lib");
const { loadConfig } = require("../lib/config.cjs");
const { VideoStack } = require("../lib/video-stack.cjs");
const config = loadConfig();
const app = new App();
new VideoStack(app, config.stackName, {
  env: { account: config.account, region: config.region },
  terminationProtection: true,
  config,
});
Tags.of(app).add("Project", "streamora");
Tags.of(app).add("Task", "T13");
