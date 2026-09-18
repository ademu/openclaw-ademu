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
    sessionRejected:
      "The Ademú device host rejected this session. Check the device in the Ademú app, then reconnect: openclaw channels add --channel ademu → Connect an already-enrolled agent.",
    warmupFailed: "reconnected, but the conversation list could not be refreshed; restarting",
    noSessionSocket:
      "The Ademú device host did not report its session socket (too old, or not an adc daemon). Upgrade adc, or point channels.ademu at a current daemon.",
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
      "Enroll this agent on Ademú (end-to-end encrypted messaging). Use when the user wants to talk to you on Ademú or asks to enroll or connect the agent to the Ademú app. Actions: start (the plugin shows the user a QR code and, later, the four safety words with Yes/No — on the enrollment page or as buttons in this conversation), status (where the enrollment stands). You can neither confirm nor cancel an enrollment: only the user does, on the page or the buttons.",
    toolLabel: "Enroll on Ademú",
    toolNeedsSession: "Enrollment needs a conversation session; ask again from a chat.",
    toolLeaseMismatch: "That enrollment belongs to another conversation (or to another sender or agent in this one); it cannot be inspected from here.",
    toolNoActive: "No enrollment is in progress. Use action \"start\" first.",
    toolAccountExists: (id: string, ids: string[]) => `An Ademú account named "${id}" already exists (${ids.join(", ")}). Choose another accountId.`,
    toolStart: (p: { payload: string; dataUrl: string; pageUrl: string; opened: boolean; lane: "page" | "push"; buttons: boolean; reply: boolean; pageReachable: boolean; channel?: string | undefined }) =>
      p.lane === "page"
        ? `Scan this with the Ademú app (phone → profile → Agents → Add):\n\n![ademu-enroll](${p.dataUrl})\n\nOr open on the phone: ${p.payload}\n\n${
            p.opened
              ? "The enrollment page has just OPENED in the user's browser on this machine — tell them to look for it."
              : "The user can open the enrollment page in a browser on the gateway machine."
          } Paste this exact URL into your reply on its own line (it is a pointer to the page, not the enrollment link — never retype the QR contents):\n${p.pageUrl}\nThe page shows the QR, then the four safety words next to a Yes and a No button. The user compares the words with their phone and clicks there. You cannot confirm or cancel anything: never ask the user to say yes to you, and never claim the enrollment finished. Call action "status" when the user asks how it is going or says they clicked.`
        : `The plugin has just sent the QR code and the exact enrollment link INTO THIS CONVERSATION (${p.channel ?? "this channel"}) — not through you. Tell the user: tap the link on the phone that runs the Ademú app (or scan the code with it from another device). When the phone has scanned, the plugin sends the four safety words here${
            p.buttons
              ? " with a Yes and a No button; the user compares them with the phone and taps one (or replies yes / no to that message)"
              : p.reply
                ? "; the user compares them with the phone and REPLIES to that message (quote it) with yes or no — a plain yes typed without quoting is not a decision"
                : ` together with a link to the enrollment page (${p.pageUrl}) where the user compares them with the phone and clicks Yes or No`
          }. You cannot confirm or cancel anything: never ask the user to say yes to you, never repeat or describe the link or the words, and never claim the enrollment finished. Call action "status" when the user asks how it is going.`,
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
    pageCancelledHeading: "Enrollment cancelled",
    pageCancelledBody: "You said the words differ, so nothing was enrolled and nothing was written. Ask the agent to connect to Ademú again when you are ready.",
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
    // ----- messages the plugin itself pushes into a chat channel (never the model) -----
    pushQrCaption: (p: { agentName: string; link: string; pageUrl?: string | undefined }) =>
      `Enroll ${p.agentName} on Ademú.\n\nOpen Ademú on your phone → your profile → Agents → Add, then scan this code. On this phone, tap the link instead:\n${p.link}${
        p.pageUrl ? `\n\nOr open the enrollment page in a browser: ${p.pageUrl}` : ""
      }\n\nThe code is valid for three minutes.`,
    pushWords: (w: readonly [string, string, string, string], how: { buttons: boolean; reply: boolean; pageUrl?: string | undefined }) => {
      const ways: string[] = [];
      if (how.buttons) ways.push("tap Yes if they match, No if they differ");
      if (how.reply) ways.push("reply to this message with yes or no");
      if (how.pageUrl) ways.push(`open ${how.pageUrl} and click Yes or No`);
      const action = ways.length === 0 ? "confirm them on the enrollment page" : ways.join(", or ");
      return `Your phone now shows four safety words. They should be:\n\n${w.join("   ")}\n\nCompare them with your phone, then ${action}.`;
    },
    /** The closed set of decision words a quoted reply may carry (lowercase, trimmed). */
    decisionYes: ["yes", "y"] as readonly string[],
    decisionNo: ["no", "n"] as readonly string[],
    buttonYes: "Yes — the words match",
    buttonNo: "No — they differ",
    buttonStale: "This enrollment is no longer active. Ask the agent to connect to Ademú again.",
    buttonNotYours: "Only the person who started this enrollment can confirm or cancel it.",
    pushEnrolled: (agentName: string) => `Enrolled — ${agentName} is on Ademú now. Message it from your phone.`,
    pushEnded: (state: string) => `The enrollment ended (${state}). Nothing was written. Ask the agent to connect to Ademú again.`,
    toolStatus: (phase: string, agentName: string) =>
      ({
        scanning: "Enrollment state: waiting for the phone to scan the code. Nothing for you to do; the user acts on the page, the buttons, or the phone.",
        words_shown: "Enrollment state: the phone has scanned; the user is comparing the four safety words and will click Yes or No on the page or the buttons, or reply yes / no to the plugin's words message. Do NOT ask the user to tell you the words or to say yes to you.",
        confirming: "Enrollment state: the user confirmed the words; the plugin is issuing the device credential and writing the account. Check again in a moment.",
        done: `Enrolled — ${agentName} is on Ademú now. The user confirmed the words themselves. The user can message you from their phone.`,
        failed: "Enrollment state: it did not finish (the words did not match, or the device was revoked). Nothing was written. The user can ask you to start again.",
        cancelled: "Enrollment state: the user cancelled it. Nothing was written. The user can ask you to start again.",
        expired: "Enrollment state: it expired (three minutes without completing). Nothing was written. The user can ask you to start again.",
      })[phase] ?? `Enrollment state: ${phase}.`,
    toolChannelUnsupported: (channel: string) =>
      `Enrollment cannot be completed from ${channel}: this channel offers no buttons and no quoted replies for the user to confirm the safety words, and the enrollment page is not reachable from outside the gateway machine. Nothing was created. Tell the user to either run \`openclaw channels add --channel ademu\` in a terminal on the gateway machine, or set channels.ademu.enrollmentPage.baseUrl to the gateway's browser-facing origin and ask again.`,
    toolPushFailed: (channel: string) =>
      `The plugin could not deliver the QR code into this ${channel} conversation, so the enrollment was not started. Nothing was created. Ask the user to try again, or to use the terminal wizard (openclaw channels add --channel ademu).`,

  },
} as const;
