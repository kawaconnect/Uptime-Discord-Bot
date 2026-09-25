import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Defence in depth: credentials must never reach the logs even if an
  // options or request object is logged by mistake.
  redact: {
    paths: [
      "authorization", "*.authorization", "headers.authorization", "*.headers.authorization",
      "Authorization", "*.Authorization", "extraHeaders", "*.extraHeaders",
      "apiKey", "*.apiKey", "token", "*.token", "pass", "*.pass", "password", "*.password",
    ],
    censor: "[redacted]",
  },
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});
