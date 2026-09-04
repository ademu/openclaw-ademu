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

  // ----- enrollment (wizard + ademu_enroll tool) -----
  enroll: {
    wizardIntro: "Ademú — enroll an agent",
    configuredLabel: "enrolled",
    unconfiguredLabel: "not enrolled",
    configuredHint: "An agent is enrolled on Ademú; add another account to enroll a second agent.",
    startingHost: "Starting the Ademú device host…",
    waitingEnrollment: "Waiting for your phone to finish enrollment…",
    mintingToken: "Issuing the device token…",
    modeQuestion: "What do you want to do?",
    modeNew: "Enroll a new agent (scan a QR with the Ademú app)",
    modeExisting: "Connect an already-enrolled agent",
    pickDevice: "Which enrolled agent should this account use?",
    noEnrolledDevices: "No enrolled agents were found on this device host. Choose “Enroll a new agent”.",
    agentNamePrompt: "Name for this agent on Ademú",
    agentNameFallback: "Ademú Agent",
    scanTitle: "Scan with the Ademú app",
    scanHint: "Open Ademú on your phone → your profile → Agents → Add, then scan this code.",
    scanLinkOnly: "This client cannot show a scannable code. Open this link on the phone that runs the Ademú app, or run `openclaw channels add --channel ademu` in a terminal for a QR:",
    wordsTitle: "Safety words",
    words: (w: readonly [string, string, string, string]) => `Your phone shows four safety words. They should be:\n\n    ${w.join("   ")}\n`,
    wordsConfirm: "Do these four words match what your phone shows?",
    wordsMismatch: "The words did not match. Enrollment was refused for your safety — nothing was enrolled. Start again when you are ready.",
    ownerGrantConfirm:
      "This makes your Ademú account an OpenClaw owner, so owner-only commands work from your phone. Say no if the phone belongs to someone other than you.",
    replaceTokenConfirm: "An OpenClaw token for this account already exists on the device. Replace it? The old token stops working.",
    takeoverConfirm: "Another program is attached to this agent right now. Connecting will disconnect it. Continue?",
    enrolled: (name: string) => `Enrolled — ${name} is on Ademú now. Message it from your phone.`,
    connected: (name: string) => `Connected — ${name} answers on Ademú through this account now.`,
    cancelled: "Enrollment cancelled. Nothing was written. Run `openclaw channels add --channel ademu` to try again.",
    notEnrolledDevice: "That agent is not enrolled yet. Finish enrollment from the Ademú app first.",
    deviceAttachedRefused: "Another program is attached to this agent; connection was not forced.",
    daemonUnreachable: (logPath: string | undefined) =>
      `The Ademú device host could not start or answer. Check the Ademú server endpoints in channels.ademu.server${logPath ? ` and the daemon log at ${logPath}` : ""}.`,
    notInstalled:
      "The Ademú device host binary is not available for this platform. Install the plugin from npm with optional dependencies enabled, or set channels.ademu.socketPath to a running adc daemon.",
    authorityExpired: "Ademú enrollment authority is no longer active.",
    toolDescription:
      "Enroll this agent on Ademú (end-to-end encrypted messaging) or connect an already-enrolled one. Use when the user wants to talk to you on Ademú or asks to enroll, link, or connect the agent to the Ademú app. Actions: start (shows a QR), wait (returns the four safety words), confirm (after the user says the words match), replace_token, cancel, status.",
    toolLabel: "Enroll on Ademú",
    toolNeedsSession: "Enrollment needs a conversation session; ask again from a chat.",
    toolLeaseMismatch: "That enrollment belongs to another conversation or its lease token is missing.",
    toolNoActive: "No enrollment is in progress. Use action \"start\" first.",
    toolAccountExists: (id: string, ids: string[]) => `An Ademú account named "${id}" already exists (${ids.join(", ")}). Choose another accountId.`,
    toolStart: (payload: string, dataUrl: string) =>
      `Scan this with the Ademú app (phone → profile → Agents → Add):\n\n![ademu-enroll](${dataUrl})\n\nOr open on the phone: ${payload}\n\nThen call ademu_enroll with action \"wait\".`,
    toolWaiting: "Still waiting for the phone to scan. Call \"wait\" again in a moment.",
    toolWords: (w: readonly [string, string, string, string]) =>
      `The phone now shows four safety words. Read them to the user and ask whether they match:\n\n${w.join("   ")}\n\nIf they match, call ademu_enroll with action \"confirm\". If they do not, call \"cancel\".`,
    toolConfirmed: (name: string) => `Enrolled — ${name} is on Ademú now. The user can message you from their phone.`,
    toolLabelExists: "A token for this account already exists on the device. Ask the user whether to replace it (the old one stops working); if yes, call action \"replace_token\".",
    toolReplaceNotAllowed: "\"replace_token\" is only valid right after \"confirm\" reported that a token for this account already exists and the user agreed to replace it.",
    toolUnavailable: (remedy: string) => `Enrollment cannot start right now. ${remedy}`,
    toolCancelled: "Enrollment cancelled; nothing was written.",
    toolStatus: (state: string) => `Enrollment state: ${state}.`,
  },
} as const;
