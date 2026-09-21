import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setCodec("h264");
Config.setPixelFormat("yuv420p");
Config.setCrf(18);
Config.setConcurrency(4);
Config.setChromiumOpenGlRenderer("angle");
Config.setBrowserExecutable(
  process.env.PROMO_CHROME ??
    "/home/inaridiy/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
);
