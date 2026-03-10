import PQueue from "p-queue";

/** Global outbound Discord queue to respect rate limits. */
export const discordQueue: PQueue = new PQueue({
  concurrency: 10,
  intervalCap: 45,
  interval: 1000,
});
