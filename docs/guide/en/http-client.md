---
title: HTTP client
nav: HTTP client
description: Send HTTP requests by hand or through agents: methods, headers and bodies, saved requests, environments with variables, secrets from the vault, a searchable history.
---

The HTTP client is for talking to APIs: checking what an endpoint answers, sending a webhook, trying a request before it goes into a script. You send requests yourself on its page, or ask an agent to. Both land in one history, so you can always see what was sent and what came back.

## Start in the chat

Say "turn on the HTTP client and send a GET to https://api.github.com/repos/nodejs/node". The agent turns the integration on, sends the request and tells you what came back. Ask "show me the response" and it arrives as a card in the chat; **Open in HTTP** on the card opens it on the page.

The HTTP client is off until you turn it on: the same switch is in **Settings** → **Plugins** → **HTTP client**. Once it is on, **HTTP** in the sidebar opens the page. Everything on the page can also be done in the chat.

## Sending a request

On the page, choose the method, type the address and press **Send**. Under the address:

- **Params**: query parameters added to the address.
- **Headers**: the request's headers.
- **Body**: for anything but GET and HEAD. Choose **JSON**, **Text** or **Form**; the matching `Content-Type` is set unless you set one in **Headers**.

A line of **Params** or **Headers** can be switched off with its checkbox without removing it.

Paste a `curl` command into the address field and it turns into the request: method, address, headers and body. **Copy as curl** does the opposite.

The response shows below: the status, the time it took, the size, then **Body** (JSON is spread out for reading) and **Headers**.

Limits: a request waits 30 seconds for an answer (an agent can ask for up to 120), up to 5 redirects are followed, and up to 5 MB of a response is read. A binary response (an image, an archive) is only measured, not kept.

## What agents can do

| You say | What happens |
|---|---|
| "GET https://api.example.com/items and tell me how many there are" | The agent reads the address. Reading needs no approval. |
| "POST this JSON to our webhook" | The agent sends it. Anything that is not a plain read asks you first, see below. |
| "what did the orders API answer yesterday?" | The agent searches the history. |
| "save this request as Create order" | It goes to **Saved**, and can be run by name. |
| "run Create order with name = Lamp" | The agent runs the saved request with that variable. |

### Approvals

Reading an address (GET, HEAD) is free. Everything that acts (POST, PUT, PATCH, DELETE) shows a card with the method and the address, and waits for your answer. **Always allow this** on the card makes a rule for that host, so requests to it stop asking (see [Approvals and auto mode](approvals.md)).

After an agent has read something from outside (a web page, a mail, a response), it is more careful with what leaves: a read with extra headers, parameters or variables also asks you first, and so does saving a request or a variable. That keeps a page from talking an agent into carrying your data out.

## Saved requests and environments

**Save** keeps the request under a name, in a group if you give one. Saved requests are on the **Saved** tab, and agents call them by name.

An environment is a set of variables. Write `{{name}}` anywhere in a request (the address, a header, the body) and it is filled from the active environment when the request leaves. Choose the active one beside the tabs; **Environments…** in the same list opens them for editing. Typical use: `{{base}}` is `https://staging.example.com` in one environment and `https://api.example.com` in another.

In the chat: "make an environment Staging with base = https://staging.example.com and make it active".

## Keys and tokens

Don't type a key into a request. Keep it in the vault and write a reference where it goes:

```text
Authorization: Bearer vault://github_token
```

The secret is put in as the request leaves. The history keeps the reference, and if a server echoes the secret back, it is cut from what is stored and from what the agent reads. `vault://id#field` takes a field other than the main one. A variable's value can be a reference too, so one environment can hold the staging key and another the production one.

To put a key into the vault, tell an agent "save my GitHub token": it asks for it on a card that goes straight to the vault (see [Security model](security.md)).

## History and search

The **History** tab lists every request, newest first: who sent it (**Me** or an agent), the method, the address, the status and the time. The search field finds words anywhere in the address, the headers and the bodies of requests and responses. The filters under it show a class of answers (**2xx**, **4xx**, **5xx**) or the requests that got no answer (**Failed**).

Press an entry to see its response again and to get its request back in the editor, ready to change and send. The cross on an entry removes it; **Clear the history** removes them all.

The history keeps the newest 5000 requests and up to 512 KB of each body. It lives on the computer the hub runs on.

## Which addresses are open

- Any public address.
- Hosts in your own network (home, office, VPN) only after you allow them: the hub asks on a card the first time.
- Never this computer itself (`localhost`, `127.0.0.1`): the hub's own services live there, and no request, yours or an agent's, goes to them.
