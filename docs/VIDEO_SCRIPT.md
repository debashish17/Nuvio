# Nuvio Remit: demo video script

About 2:53, under Devpost's 3-minute limit. It is a pitch, not a tutorial: the problem first, then who it's for and how it uses Alexa+, then the product working. The step-up moment is the centrepiece.

- **Voice-over:** 241 words, about 96 seconds at 150 words a minute. Read the lines marked **Voice-over**.
- **The assistant's own voice and Priya's typed lines** fill the rest. Keep the assistant's audio where the script says so.
- **Every assistant line** was captured from a run of the simulator, so the screen matches. Values in *[brackets]* change from run to run.
- **Alexa+** is named in four voice-over lines and on both title cards.

| Time | Beat | The point |
| --- | --- | --- |
| 0:00–0:14 | 1 · The problem | Voice is the weakest way to approve a payment |
| 0:14–0:28 | 2 · An Alexa+ add-on | An MCP server; the simulator stands in for Alexa+ |
| 0:28–0:52 | 3 · It remembers | `get_pending`: what's waiting, read from the ledger; under review, never the reason |
| 0:52–1:43 | 4 · The send | Read-back, yes, a code to the phone, sent; the model never sees the code |
| 1:43–2:01 | 5 · Limits | The server refuses; the model explains |
| 2:01–2:13 | 6 · Tracking | Paid out, all the way to Mum's bank |
| 2:13–2:26 | 7 · Rate alert | Set now, raised in the next conversation |
| 2:26–2:43 | 8 · How it's built | 14 tools, MCP Apps view, Agent Skill, Bedrock, Polly, npm |
| 2:43–2:53 | 9 · Close | Runs with nothing but Node |

If a take runs long, cut beat 7 first.

---

## 1 · The problem · 0:00–0:14

**Show**

- Title card for two seconds: **Nuvio Remit · an Alexa+ add-on**.
- The simulator at rest: the orb breathing, the banner "Simulated ledger: no real funds move" in view, panels hidden (press `H`).

| Who | Line |
| --- | --- |
| **Voice-over** | Every month, Indian workers in the UAE send money home to family. Doing it by voice sounds easy, but it's risky: a misheard amount, an assistant that improvises, or anyone in the room saying yes. |

## 2 · An Alexa+ add-on · 0:14–0:28

**Show**

- Panels back on (`H`). The protocol panel lists the session's 14 tools.
- Lower third: **Alexa+ add-on · MCP server · 14 tools**.
- Optional: a three-second cut to the README's "Built for Alexa+" table.

| Who | Line |
| --- | --- |
| **Voice-over** | Nuvio Remit is an Alexa+ add-on that makes it safe. Amazon's Alexa+ tools aren't available to hackathon builders, so we built a simulator that calls our MCP server exactly as Alexa+ would. |

## 3 · It remembers · 0:28–0:52

**Show:** the caption and the welcome reply. The protocol panel shows one call: `get_pending`.

| Who | Line |
| --- | --- |
| Priya (Play demo, **Say it**) | Hi, anything I should know? |
| Assistant, keep the audio | Welcome back, Priya. Your 5,000 dirham transfer to your NRE account is under review: upload updated Emirates ID in the Nuvio app by *[two days from today]*. |
| **Voice-over** | It opens with what's waiting, read from the ledger, not from stored chats. Under review comes with the next step and never the reason: screening rules forbid tipping a customer off. |

## 4 · The send: read-back, yes, code · 0:52–1:43

**Show**

- The MCP Apps transfer view moves to the read-back with its five-minute countdown. Lower third: **Read back word for word, from the server**.
- After "Yes": the phone toast with the SMS (code, amount, recipient). Hold on it for a beat.
- After the code: the orb gathers into a check mark, the view shows the live receipt, and the ledger strip updates.
- The protocol panel: `resolve_beneficiary`, `quote_transfer`, `prepare_transfer` (token masked), then `confirm_transfer` twice. The second carries the masked code and is marked "moves money".

| Who | Line |
| --- | --- |
| Priya | Send 2,000 dirhams to Mum. |
| Assistant, keep all of it | Send 2,000 dirhams to Mum, Sunita Nair at HDFC Bank ending 4421, for family maintenance. The 15 dirham fee is included and the rate is *[today's rate]*; your card ending 8812 is charged 2,000 dirhams. Mum receives *[amount]* rupees, guaranteed, within minutes. Shall I go ahead? |
| **Voice-over** | Alexa+ reads back the server's own words. Nothing moves without a yes. |
| Priya | Yes. |
| Assistant, keep the audio | I've texted a code to your phone ending 4471. Please read it out. |
| **Voice-over** | And a yes isn't enough: a one-time code goes to her phone, never to the model. |
| Priya | *[the six digits on the phone toast]*: the code changes every run. Read whatever the toast shows, or type it into the transfer view. |
| Assistant, keep the audio | Done. NUV-*[ref]* is on its way to Mum. |
| **Voice-over** | So the model can't approve a payment. Only the phone in Priya's hand can. |

## 5 · Limits live on the server · 1:43–2:01

**Show:** the refusal card, and the protocol panel's JSON with `refused MONTHLY_LIMIT`: the server said no, not the model.

| Who | Line |
| --- | --- |
| Priya | Send her another three thousand. |
| Assistant, keep the audio | That would go over your monthly limit. Send up to 1,500 dirhams now, or raise your limit by adding salary proof in the Nuvio app. |
| **Voice-over** | Limits live on the server. The model explains a refusal; it can't argue past one. |

## 6 · Tracking · 2:01–2:13

**Show**

- Before the take, press **Advance ticker** in the dev drawer until the view reaches Paid out.
- The receipt steps at Paid out, with the full bank reference on screen.
- The protocol panel: `get_transfer_history`, `track_transfer`.

| Who | Line |
| --- | --- |
| Priya | Where's Mum's money? |
| Assistant, keep the audio | It has been paid out. The bank reference ends in *[last four]*; the full reference is in the Nuvio app. |
| **Voice-over** | Tracked all the way to Mum's bank. |

## 7 · Rate alert · 2:13–2:26

**Show:** the alert card, then press **Fire rate alert** in the dev drawer and let the toast slide in. The protocol panel: `set_rate_alert`.

| Who | Line |
| --- | --- |
| Priya | Tell me when the dirham hits 26.5. |
| Assistant, keep the audio | I'll let you know when a dirham buys more than 26.50 rupees. Today it buys *[today's rate]*. |
| **Voice-over** | When it fires, Alexa+ brings it up in the next conversation. |

## 8 · How it's built · 2:26–2:43

**Show** (about three seconds each)

1. The README's "Built for Alexa+" table.
2. `skills/nuvio-remit/SKILL.md` in the editor.
3. The protocol panel heading with the model name (`nova-2-lite`) and its token count.
4. A terminal: `pnpm test` ending in all tests passed, and the green CI badge.
5. The npm page for `mcp-confirm-gate`.

| Who | Line |
| --- | --- |
| **Voice-over** | Under the hood, the Alexa+ add-on is fourteen MCP tools, an MCP Apps view, and an Agent Skill for any agent. The assistant runs on Amazon Bedrock, Nova 2 Lite, with Amazon Polly for the voice. The gate is open source on npm. |

## 9 · Close · 2:43–2:53

**Show:** back to the check mark in the simulator, then the end card: **Nuvio Remit · an Alexa+ add-on · github.com/debashish17/Nuvio**.

| Who | Line |
| --- | --- |
| **Voice-over** | Anyone can run the whole demo on a clean clone with nothing but Node. Nuvio Remit: money home by voice, and only with your yes. |

---

## Run sheet

**Pick the mode**

- **Live (recommended).** Sign in with `aws login --profile acme-remit` and start the server with `AWS_PROFILE=acme-remit`. The answers come from Bedrock's Nova 2 Lite, and the voice is Polly's Kajal. A full run measured about 7 cents (Bedrock about 1.4, Polly about 5.4), and every retake costs about the same.
- **Scripted (free).** No AWS: the same lines through the real tools, in the browser's voice. The protocol heading then says "scripted", so keep at least beat 4 live, because beat 8 says the assistant runs on Bedrock.

**Set up the screen**

1. `pnpm db:seed`, then `pnpm dev`. It builds the transfer view too.
2. Open `http://localhost:3000/?dev=1`, then enter the access code and the dev-controls code from your `.env`.
3. Blue theme, Voice on. Use a 1920×1080 window at 125% zoom so the text reads on YouTube.
4. Minimise the dev drawer between uses. Hide the panels with `H` for clean shots, and show them for beats 2 to 6.

**Drive the takes**

1. **Play demo**, then **Say it** beat by beat. Record each beat as its own take and stitch them together.
2. **Skip** the beats this cut leaves out:
   - "What's the rupee at today?"
   - "How much would Mum get for 2,000 dirhams?"
   - "Send 500 to Rahul."
   - "And the one to my NRE account?"
   - "Cancel the one to my NRE account." and the "Yes." after it
3. Before "Where's Mum's money?", press **Advance ticker** until the view shows Paid out.
4. After the alert is set, press **Fire rate alert**.
5. Press **Reset demo data** before the next take.

**Keep out of frame, then upload**

- Keep out of frame: anything from `.env`, the access codes, the AWS console, and any terminal holding a token.
- No third-party music or logos.
- Upload to YouTube: public, English, under 3:00. Captions help with the accents.
- Put the link in the README and in Devpost.

---

## Voice-over only

For reading in one pass, with the times to land each line.

| At | Voice-over |
| --- | --- |
| 0:00 | Every month, Indian workers in the UAE send money home to family. Doing it by voice sounds easy, but it's risky: a misheard amount, an assistant that improvises, or anyone in the room saying yes. |
| 0:14 | Nuvio Remit is an Alexa+ add-on that makes it safe. Amazon's Alexa+ tools aren't available to hackathon builders, so we built a simulator that calls our MCP server exactly as Alexa+ would. |
| 0:39 | It opens with what's waiting, read from the ledger, not from stored chats. Under review comes with the next step and never the reason: screening rules forbid tipping a customer off. |
| 1:12 | Alexa+ reads back the server's own words. Nothing moves without a yes. |
| 1:23 | And a yes isn't enough: a one-time code goes to her phone, never to the model. |
| 1:37 | So the model can't approve a payment. Only the phone in Priya's hand can. |
| 1:55 | Limits live on the server. The model explains a refusal; it can't argue past one. |
| 2:10 | Tracked all the way to Mum's bank. |
| 2:21 | When it fires, Alexa+ brings it up in the next conversation. |
| 2:26 | Under the hood, the Alexa+ add-on is fourteen MCP tools, an MCP Apps view, and an Agent Skill for any agent. The assistant runs on Amazon Bedrock, Nova 2 Lite, with Amazon Polly for the voice. The gate is open source on npm. |
| 2:43 | Anyone can run the whole demo on a clean clone with nothing but Node. Nuvio Remit: money home by voice, and only with your yes. |
