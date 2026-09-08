// POSITIVE: the host's chained child-logger sink must be recognized as a log call-site.
export function bait(runtime, token) {
  runtime.logging.getChildLogger({ plugin: "ademu" }).info("session opened", { token });
}
