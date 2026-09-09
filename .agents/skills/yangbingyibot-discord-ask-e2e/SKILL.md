---
name: yangbingyibot-discord-ask-e2e
description: Run the production Discord `/ask` end-to-end check for yangbingyibot using locally configured Discord and source-spreadsheet URLs with the user's Chrome session. Use after a production deployment, when verifying Discord interaction handling, or when the user asks to test `/ask`, the Discord bot, or the deployed Worker end to end.
---

# Yangbingyibot Discord `/ask` E2E

Use the Chrome control skill and the user's authenticated Discord session to
exercise the real slash-command path:

Discord client → signed Interaction → production Cloudflare Worker → Answer
Question Workflow → Gemini and Google Sheets → Discord response.

This is the production E2E check. Do not replace it with a fabricated
Interaction POST, a plain Discord message, a bot-token command invocation, or a
Discord user-token/internal API call.

## Local configuration

Read `.agents/local/yangbingyibot-discord-ask-e2e.json` from the repository
root. The `.agents/local/` directory is ignored by Git; this file is local to
the checkout and must never be committed. It contains:

```json
{
  "discordChannelUrl": "configured locally",
  "sourceSpreadsheetUrl": "configured locally",
  "expectedDiscordServer": "configured locally",
  "expectedDiscordChannel": "configured locally"
}
```

Do not print the configuration contents or include either URL in responses,
logs, patches, commits, or pull-request text. If the file or a required field is
missing, stop and ask the user to configure it locally.

## Test question

Use a user-supplied question when one is provided. Otherwise:

1. Open `sourceSpreadsheetUrl` in the user's authenticated Chrome session. Use
   a read-only export of the referenced sheet when available; otherwise inspect
   it in Google Sheets. Never edit the spreadsheet.
2. Select a row with a populated member name, nickname, and nickname-origin
   value. Avoid missing/error values and sensitive, sexual, or derogatory test
   content.
3. Prefer a candidate that does not appear in the recent visible messages in
   the configured Discord test channel.
4. Create a concise Japanese question asking for the member's name and the
   nickname's origin in one sentence. Record the expected name and origin from
   the source before submitting the command.

Do not use a fixed fallback question. If no safe, verifiable row is available,
stop and report that the source did not provide a suitable test case.

Do not include secrets, credentials, personal data, or production diagnostics
in the test question.

## Workflow

1. Read and follow the Chrome control skill before browser work.
2. Load the local configuration and derive the test question and expected facts
   as described above.
3. Connect to the user's Chrome session and name the browser session
   `🧪 Discord /ask E2E`.
4. Open `discordChannelUrl` in a new Chrome tab. Do not reuse a live Discord tab
   unless the user explicitly asks to reuse it.
5. If Discord asks the user to log in again, stop before credential entry and
   ask the user to complete login. Continue in the test-channel tab after the
   user confirms login.
6. Verify the visible server and channel match `expectedDiscordServer` and
   `expectedDiscordChannel`, and the signed-in account is the intended account.
7. In the message composer:
   - Enter `/ask`.
   - Select the `/ask` command whose question option is described as
     `Ask 433 a question` and whose application is `sushanshan`.
   - Enter the test question in the `question` option.
8. Immediately before the final Enter key that submits the command, request
   action-time confirmation. State the exact channel, command, and question.
   Preserve the prepared tab as a handoff while waiting.
9. After explicit confirmation, reclaim the prepared tab, verify the exact
   command and question are still present, and press Enter once.
10. Confirm that the submitted question appears in the channel.
11. Wait for the `sushanshan` application response. Use targeted DOM checks
    around the submitted question rather than repeatedly dumping the entire
    message history.
12. Classify the result:
    - **PASS**: the application posts a non-empty answer for the submitted
      question, the answer matches the expected source facts, and Discord does
      not show
      `アプリケーションが応答しませんでした`.
    - **FAIL — interaction timeout**: Discord shows
      `アプリケーションが応答しませんでした`.
    - **FAIL — response error**: the application responds with an explicit
      error or never produces an answer within 60 seconds.
13. Report the channel, question, PASS/FAIL status, visible answer or error, and
    the observed timestamp. Do not expose configured URLs or claim success from
    request submission alone.
14. Finalize Chrome as the last browser action:
    - Keep a completed result tab as `deliverable`.
    - Keep a login, confirmation, or other unfinished tab as `handoff`.

## Failure handling

- Do not automatically resend the command; a late workflow may still complete,
  and a retry can duplicate production work.
- Record the visible Discord error and approximate submission time for log
  correlation.
- Treat `アプリケーションが応答しませんでした` as evidence that Discord did
  not receive the initial Interaction response in time. It does not by itself
  prove that the Worker received nothing or that downstream processing never
  started.
- When diagnosis is in scope, correlate the timestamp with Cloudflare Worker
  and Workflow logs using read-only checks. Distinguish network/sandbox errors
  from authentication errors and never expose secrets.
- Ask before any production write, rollback, redeploy, or destructive recovery
  action.
