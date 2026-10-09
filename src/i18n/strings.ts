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
      "Ademú device token rejected (revoked or rotated). Re-enroll or reconnect this agent: openclaw channels add --channel ademu → I have a device token.",
    notEnrolled:
      "This Ademú device is not enrolled yet. Finish enrollment from the Ademú app, or re-run: openclaw channels add --channel ademu.",
    displaced:
      "Another process attached to this Ademú device and took the session. Stop it, then restart this channel.",
    protocolViolation: "The Ademú device host answered with a malformed frame; restart the channel.",
    sessionRejected:
      "The Ademú device host rejected this session. Check the device in the Ademú app, then reconnect: openclaw channels add --channel ademu → I have a device token.",
    warmupFailed: "reconnected, but the conversation list could not be refreshed; restarting",
    noSessionSocket:
      "The Ademú device host did not report its session socket (too old, or not an adc daemon). Upgrade adc, or point channels.ademu at a current daemon.",
    identityMismatch:
      "The configured Ademú account does not match the device its token belongs to (deviceId/agentUserId/ownerUserId). Fix channels.ademu.accounts or reconnect the agent.",
    unsupportedPlatform: (platform: string) => `Ademú is not available on ${platform} yet.`,
    // ----- the installed device host (AdemuMLS #712: the plugin attaches, never runs one) -----
    adcNotInstalled:
      "The Ademú device host (adc) is not set up as a background service for the user this OpenClaw gateway runs as. Install adc as that user (the adc installer sets up the service), or, if adc is already installed, run ~/.local/bin/adc service install.",
    adcServiceDisabled:
      "The adc background service is disabled for this user (on macOS: System Settings → General → Login Items). Re-enable it, then run ~/.local/bin/adc service start.",
    adcNotRunning: "The Ademú device host (adc) is not running. Start it: ~/.local/bin/adc service start.",
    adcNotRunningAt: (enrollSocket: string) =>
      `Nothing answers at the configured Ademú device host (${enrollSocket}). Start that adc daemon; the plugin never starts one at a configured path.`,
    adcNotAnswering: (dataDir: string) =>
      `The adc background service was started but did not answer within 20 seconds. Check ~/.local/bin/adc service status and its log (macOS: ${dataDir}/daemon.log; Linux: journalctl --user -u adc).`,
    systemDaemonDown: "This host's system-wide Ademú device host is not running. Ask the operator to start it: sudo adc --system service start.",
    notEnrollSocket: (dialled: string, reported: string) =>
      `The socket configured as the Ademú enrollment socket (${dialled}) is not the device host's enrollment socket (it reports ${reported}). Fix channels.ademu.enrollSocketPath, or remove it to use the installed service's own.`,
    adcTooOld: "The Ademú device host (adc) is too old for this plugin. Upgrade it: re-run the adc installer (it restarts the service).",
    sessionSocketMoved: "The Ademú device host moved its session socket; reconnecting.",
    privilegeDenied:
      "This host's Ademú device host refused this user: permission denied on its enrollment socket. Ask the operator to grant access, or point channels.ademu at a device host this user may use.",
    ingressHalted: "Inbound processing halted before a message was adopted; restarting to replay.",
    securityNotice: "An Ademú security notice was raised for a conversation; see the room.",
    configCollision: (detail: string) => detail,
    accountDisabled: "This Ademú account is disabled.",
    notConfigured: "This Ademú account has no device token yet. Enroll it: openclaw channels add --channel ademu.",
  },

  room: {
    securityNotice: "Ademú flagged this conversation with a security notice. Decline to converse here until it is cleared.",
  },

  // ----- inbound files (AdemuMLS #440): the turn text the agent reads for a non-text message -----
  media: {
    kinds: { photo: "photo", video: "video", voice: "voice note", file: "file" },
    file: (f: { kind: string; ordinal: { index: number; count: number } | undefined; filename: string; size: string }) => {
      const head = f.ordinal ? `${f.kind} ${f.ordinal.index} of ${f.ordinal.count}` : f.kind;
      const facts = [f.filename, f.size].filter((s) => s.length > 0).join(", ");
      return `[${head}${facts ? `: ${facts}` : ""} — this channel can't open files yet]`;
    },
    anyFile: "[a file — this channel can't open files yet]",
    unknownKind: "[a message of a kind this channel can't show]",
  },

  // ----- enrollment (wizard + ademu_enroll tool) -----
  enroll: {
    wizardIntro: "Ademú — enroll an agent",
    configuredLabel: "enrolled",
    unconfiguredLabel: "not enrolled",
    configuredHint: "An agent is enrolled on Ademú; add another account to enroll a second agent.",
    startingHost: "Connecting to the Ademú device host…",
    waitingEnrollment: "Waiting for your phone to finish enrollment…",
    mintingToken: "Issuing the device token…",
    modeQuestion: "What do you want to do?",
    modeNew: "Enroll a new agent (scan a QR with the Ademú app)",
    modeToken: "I have a device token (connect an already-enrolled agent)",
    tokenPrompt: "Paste the device token (minted with `adc token mint` for the enrolled agent)",
    tokenEmpty: "A device token is required.",
    tokenRejected:
      "The Ademú device host rejected that token (revoked, rotated, or mistyped). Mint a fresh one at the adc CLI for the enrolled agent and paste it again.",
    attachingSystemDaemon: "Connecting to this host's Ademú device host (system install)…",
    checkingToken: "Checking the device token with the Ademú device host…",
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
    takeoverConfirm: "Another program is attached to this agent right now. Connecting will disconnect it. Continue?",
    enrolled: (name: string) => `Enrolled — ${name} is on Ademú now. Message it from your phone.`,
    connected: (name: string) => `Connected — ${name} answers on Ademú through this account now.`,
    cancelled: "Enrollment cancelled. Nothing was written. Run `openclaw channels add --channel ademu` to try again.",
    notEnrolledDevice: "That agent is not enrolled yet. Finish enrollment from the Ademú app first.",
    deviceAttachedRefused: "Another program is attached to this agent; connection was not forced.",
    // ----- the operator's path (hardened host, lost mint, orphaned token; spec M20 b–d) -----
    operatorSteps: (prefix: string, agentName: string, label: string) =>
      [
        "An operator (root, or a member of the adc group) can enroll the agent and hand over its token:",
        "",
        `  1. ${prefix} agent add ${agentName}`,
        "     then scan the QR with the Ademú app and confirm the four safety words on the phone",
        `  2. ${prefix} token mint <device_id> --label ${label}`,
        "  3. openclaw channels add --channel ademu → “I have a device token” → paste the token",
      ].join("\n"),
    operatorInstructions: (steps: string) =>
      `Enrollment is not possible from this account on this host: the Ademú device host is a system install and its enrollment socket refused this user. Nothing was created.\n\n${steps}`,
    quotaFull: (prefix: string, steps: string) =>
      `The Ademú device host's enrollment budget is full (too many unfinished enrollments on this host). Nothing was created. Cancel stale ones (\`${prefix} agent list\`, then \`${prefix} agent cancel <device_id>\`) or wait for them to expire, then try again.\n\n${steps}`,
    mintLost: (command: string) =>
      `Enrollment reached the end, but the device token could not be issued (its reply was lost, or the label is already taken) and that cannot be retried from here. Nothing was written. Mint a fresh token at the CLI:\n\n  ${command}\n\nthen run \`openclaw channels add --channel ademu\` and choose “I have a device token”.`,
    orphanedToken: (command: string) => `A device token was issued but the configuration was not written, so that token is orphaned. Revoke it:\n\n  ${command}`,
    enrollSocketUnreachable: (steps: string) =>
      `The Ademú device host did not answer on its enrollment socket. If it is starting, try again in a moment; if it is not running, start it (~/.local/bin/adc service start, or check channels.ademu.dataDir / enrollSocketPath). Nothing was created.\n\n${steps}`,
    toolCommitFailed: "The enrollment finished on the device host, but OpenClaw could not write the configuration; nothing was saved.",
    authorityExpired: "Ademú enrollment authority is no longer active.",
    toolDescription:
      "Enroll this agent on Ademú (end-to-end encrypted messaging). Use when the user wants to talk to you on Ademú or asks to enroll or connect the agent to the Ademú app. Actions: start (the plugin opens the enrollment page in a browser on the gateway machine; it shows a QR code and, later, the four safety words with Yes/No), status (where the enrollment stands; re-opens the page if no browser showed it). While an enrollment is in progress, start creates nothing and reports where it stands: only the user can end it, on the page. You are never given the page's address, the QR or the words, and you can neither confirm nor cancel an enrollment: only the user does, on the page.",
    toolLabel: "Enroll on Ademú",
    toolNeedsSession: "Enrollment needs a conversation session; ask again from a chat.",
    toolLeaseMismatch: "That enrollment belongs to another conversation (or to another sender or agent in this one); it cannot be inspected from here.",
    toolNoActive: "No enrollment is in progress. Use action \"start\" first.",
    toolAccountExists: (id: string, ids: string[]) => `An Ademú account named "${id}" already exists (${ids.join(", ")}). Choose another accountId.`,
    toolStart:
      "The enrollment page has just OPENED in a browser tab on this machine (the gateway machine) — tell the user to look for it. The page shows a QR code to scan with the Ademú app (phone → profile → Agents → Add), then the four safety words next to a Yes and a No button; the user compares the words with their phone and clicks there. You were given no link, no code and no words, and there is nothing for you to paste or repeat. You cannot confirm or cancel anything: never ask the user to say yes to you, and never claim the enrollment finished. Call action \"status\" when the user asks how it is going, says they clicked, or says no page appeared.",
    toolStatusReopened: "No browser had shown the page yet, so the plugin has opened it again just now — tell the user to look for the new tab.",
    toolStartAlreadyRunning:
      "An enrollment is already in progress in this conversation, so nothing new was created; the user finishes or cancels it on the enrollment page (Cancel before scanning, No after), or it expires after three minutes.",
    toolPageUnreachable:
      "Enrollment cannot start from here: the enrollment page can only be shown in a browser on the gateway machine, and this gateway does not listen on a loopback address, so no such page exists. Nothing was created. Tell the user to run `openclaw channels add --channel ademu` in a terminal on the gateway machine.",
    toolPageOpenFailed:
      "Enrollment was cancelled before anything was written: the enrollment page could not be opened in a browser on the gateway machine (no desktop session or no browser opener there). Tell the user to run `openclaw channels add --channel ademu` in a terminal on the gateway machine.",
    // ----- the browser enrollment page (src/enrollment-page-html.ts) -----
    pageTitle: "Enroll on Ademú",
    pageLoading: "Connecting to the enrollment…",
    pageScanHeading: "Scan with the Ademú app",
    pageQrAlt: "Ademú enrollment QR code",
    pageCannotScan: "Can't scan?",
    pageCannotScanHint: "Open this exact link on the phone that runs the Ademú app:",
    pageCopy: "Copy link",
    pageCopied: "Copied",
    pageWordsHeading: "Compare the safety words",
    pageWordsHint: "Your phone has scanned the code and shows four safety words. This side derived:",
    pageYes: "Yes — the words match",
    pageConfirming: "Confirming…",
    pageConfirmedWait: "Confirmed — finishing enrollment…",
    pageMismatchWarn: "If they do NOT match, do not confirm: close this page and tell the agent the words differ.",
    pageNo: "No — they differ",
    pageCancelScan: "Cancel this enrollment",
    pageCancelScanHint: "Changed your mind, or did not ask for this? Cancel here; nothing is written.",
    pageCancelledHeading: "Enrollment cancelled",
    pageCancelledBody: "Nothing was enrolled and nothing was written. Ask the agent to connect to Ademú again when you are ready.",
    pageCancelling: "Cancelling…",
    pageConfirmingHeading: "Finishing enrollment…",
    pageConfirmingHint: "The words were confirmed; the device token is being issued and the account written.",
    pageEnrolledHeading: "Enrolled",
    pageEnrolled: "The agent is on Ademú now. Message it from your phone. You can close this page.",
    pageFailedHeading: "Enrollment did not finish",
    pageFailedReason: (state: string) => `The enrollment ended (${state}). Ask the agent to connect to Ademú again.`,
    pageCancelled: "This enrollment was cancelled or has expired. Nothing was written. Ask the agent to connect to Ademú again.",
    pageNotReady: "The phone has not scanned the code yet.",
    pageExpiredHeading: "This page is no longer live",
    pageExpired: "Ask the agent to connect to Ademú again.",
    pageNoScript: "This page needs JavaScript. Ask the agent to start the enrollment again from a chat client that can show the code and the words.",
    pageUnreachable: "Cannot reach the gateway — retrying…",
    pageConfirmFailed: "Confirmation failed — try again.",
    toolConfirmed: (name: string) => `Enrolled — ${name} is on Ademú now. The user can message you from their phone.`,
    toolRouted: (agentId: string, accountId: string) =>
      `Messages to this Ademú account are routed to OpenClaw agent "${agentId}" (binding ademu:${accountId}).`,
    toolAgentUnknown:
      "Enrollment refused: this conversation is not attributed to a configured OpenClaw agent, so the new account could not be routed to one. Enroll from that agent's own chat, or run `openclaw channels add --channel ademu` in a terminal. Nothing was written.",
    toolRoutingConflict: (accountId: string, existingAgentId: string) =>
      `Enrollment refused: ademu:${accountId} is already routed to OpenClaw agent "${existingAgentId}" and was left as is. Start again with another accountId, or first run: openclaw agents unbind --agent ${existingAgentId} --bind ademu:${accountId}. Nothing was written.`,
    toolUnavailable: (remedy: string) => `Enrollment cannot start right now. ${remedy}`,
    toolCancelled: "Enrollment cancelled; nothing was written.",
    toolStatus: (phase: string, agentName: string) =>
      ({
        scanning: "Enrollment state: waiting for the phone to scan the code shown on the enrollment page. Nothing for you to do; the user acts on the page or the phone.",
        words_shown: "Enrollment state: the phone has scanned; the user is comparing the four safety words and will click Yes or No on the page. Do NOT ask the user to tell you the words or to say yes to you.",
        confirming: "Enrollment state: the user confirmed the words; the plugin is issuing the device credential and writing the account. Check again in a moment.",
        done: `Enrolled — ${agentName} is on Ademú now. The user confirmed the words themselves. The user can message you from their phone.`,
        failed: "Enrollment state: it did not finish (the words did not match, or the device was revoked). Nothing was written. The user can ask you to start again.",
        cancelled: "Enrollment state: the user cancelled it. Nothing was written. The user can ask you to start again.",
        expired: "Enrollment state: it expired (three minutes without completing). Nothing was written. The user can ask you to start again.",
      })[phase] ?? `Enrollment state: ${phase}.`,
  },
} as const;
