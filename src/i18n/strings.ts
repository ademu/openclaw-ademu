// Every user-facing string of the plugin lives here so the vocabulary gate (test/gates/) can scan
// ONE place. Rule (design decision 2): say "enroll" on every surface — wizard copy, tool
// descriptions, skill text, README, channel blurb; the other word is banned by the gate. Library
// method names are internal and never appear in copy.
export const strings = {
  channelLabel: "Ademú",
  channelBlurb:
    "End-to-end encrypted messaging with your agent, from your phone; install the plugin to enable.",
} as const;
