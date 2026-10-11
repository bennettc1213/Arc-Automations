# When something goes wrong with a client's texts

One page for whoever is looking after ARC that day. Read it once before the pilot starts.
Phone numbers and logins are not in this repository, which is public: keep them with this
page wherever you keep it.

## 1. Stop first, then look

Pick the smallest stop that covers the problem. None of them stops the business's phone
ringing, and none deletes anything.

| What is wrong | The stop | What it does |
|---|---|---|
| One client's texts are wrong or unwanted | Console → the client → **lead recovery** → **pause** | New calls are still recorded, with no text. Everything queued that would reach a customer is cancelled. Nothing starts again until an operator activates it. |
| One customer should not be texted | The customer replies STOP, or an operator stops the lead on the client's page | That number is never texted again for that client. |
| Texts are wrong for every client, or you do not know which | In the SQL editor: `select cron.unschedule('arc-lead-recovery-dispatch');` | Nothing sends without the dispatcher. Calls and replies are still recorded and queue up. Put the schedule back with the statement in `DEPLOYMENT.md` section 5. |
| ARC should not be in the call path at all | The owner turns off no-answer forwarding with their phone company | Their phone behaves as it did before ARC. Nothing reaches ARC, so nothing is texted. |

After a pause, a text that was already handed to the phone network may still arrive. A send
whose result is unknown is never sent again by ARC: settle it on the client's page, which
records the answer and resends nothing.

## 2. What you are probably looking at

| What you see | Likely cause | Check |
|---|---|---|
| An alert starting "Automatic check" | Nothing has reached ARC from that line for 48 hours. A slow stretch, or forwarding is off | Ring the client's number from a phone that is not theirs and let it ring out. A text back within about a minute means the line is fine: resolve the alert. No text means forwarding, the number's webhooks, or the dispatcher |
| Calls are recorded and no text goes out | The dispatcher's schedule is missing or its key is wrong; the client is paused; the registration is not approved | The client's page shows the state and why. `select * from cron.job;` shows the schedule |
| No call is recorded at all | Forwarding is off, or the number's webhook address is wrong, or the signature check is refusing | Twilio's console → the number → its call log and webhook errors. A 403 there is the signature: the token on the project does not match the account |
| A customer says they got a text they should not have | Read the lead's thread on the client's page before answering. Every text and why it went is there | If it is a real fault, pause that client first |
| The owner did not get an alert text | Alerts go by text only, to the numbers in the client's settings, and a paused client sends none | The client's settings → staff alerts |

## 3. Who to call

Fill these in where you keep this page. Do not commit them.

- **The client's owner.** Their mobile, from the client's settings.
- **Twilio support**, from the Twilio console's help menu. For blocked or filtered texts, a
  suspended number, or a registration problem. Have the message's id ready.
- **Supabase support**, from the project's dashboard. For the database or the functions
  being down.
- **The client's phone company.** Only the owner can call them. For forwarding that will
  not turn on or off.
- **Whoever covers for you**, if anyone does. If nobody does, say so to the client before
  the pilot starts.

## 4. What to tell the owner

Say what happened, what you did, and what happens next. Do not guess at a cause you have
not confirmed.

**Texts stopped going out.**
"Between [time] and [time] the text-back was not sending. Your phone was ringing as normal
the whole time. [N] missed calls came in during that window and are listed on your jobs
screen with their numbers, so you can call them back. It is sending again now. I will tell
you what caused it once I am sure."

**A text went out that should not have.**
"A customer on [number] got a text from your number that they should not have. I have paused
the text-back on your line while I check, so no more will go. Your phone still rings as
normal. I will call you by [time] with what happened."

**Nothing has come in for a while.**
"We have not seen a missed call from your line since [day]. That may just be a slow few
days. Can you check that calls nobody answers are still being sent on to [the ARC number]?
I will ring your line myself and let it ring out to test it."

## 5. Afterwards

Write down the time it started, the time you knew, the time it was stopped, what the owner
was told, and the cause once known. Resolve the alert on the console's alerts page so the
client's reliability page shows it closed. If a job was lost because of it, it does not go
on the bill.
