// Every user-facing string of the plugin lives here so the vocabulary gate (test/gates/) can scan
// ONE place. Rule (design decision 2): say "enroll" on every surface — wizard copy, tool
// descriptions, skill text, README, channel blurb; the other word is banned by the gate. Library
// method names are internal and never appear in copy. Nothing here ever interpolates a token, a
// QR payload, the safety words, or daemon `.detail` text.
export const strings = {
  channelLabel: "Ademú",
  channelBlurb:
    "End-to-end encrypted messaging with your agent, from your phone; install the plugin to enable.",

  // ----- account status (ChannelAccountSnapshot.lastError) -----
  status: {
    reconnecting: (attempt: number) => `reconnecting to the Ademú device host (attempt ${attempt})`,
    tokenRevoked:
      "Ademú device token rejected (revoked or rotated). Re-enroll or reconnect this agent: openclaw channels add --channel ademu → Connect an already-enrolled agent.",
    notEnrolled:
      "This Ademú device is not enrolled yet. Finish enrollment from the Ademú app, or re-run: openclaw channels add --channel ademu.",
    displaced:
      "Another process attached to this Ademú device and took the session. Stop it, then restart this channel.",
    protocolViolation: "The Ademú device host answered with a malformed frame; restart the channel.",
    identityMismatch:
      "The configured Ademú account does not match the device its token belongs to (deviceId/agentUserId/ownerUserId). Fix channels.ademu.accounts or reconnect the agent.",
    unsupportedPlatform: (platform: string) => `Ademú is not available on ${platform} yet.`,
    daemonUnreachable: (logPath: string | undefined) =>
      `The Ademú device host is not reachable. Check channels.ademu.server${logPath ? ` and the daemon log at ${logPath}` : ""}.`,
    daemonLost: "The Ademú device host exited; restarting.",
    ingressHalted: "Inbound processing halted before a message was adopted; restarting to replay.",
    securityNotice: "An Ademú security notice was raised for a conversation; see the room.",
    configCollision: (detail: string) => detail,
    accountDisabled: "This Ademú account is disabled.",
    notConfigured: "This Ademú account has no device token yet. Enroll it: openclaw channels add --channel ademu.",
  },

  room: {
    securityNotice: "Ademú flagged this conversation with a security notice. Decline to converse here until it is cleared.",
  },
} as const;
