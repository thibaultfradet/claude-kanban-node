# Kanban ticket

Create or update a ticket in Claude Kanban (the local board at
`http://127.0.0.1:8787`), so that a headless agent can then run it on its own.

## Step 1: Identify the project

Never silently guess the project. Explicitly confirm with the user:
- the project **name**
- the **absolute path** of its folder (by default this session's working directory,
  but ask for confirmation at the slightest doubt)

## Step 2: New ticket or feedback on an existing one?

If the user refers to a ticket that already exists (a ticket number, "that didn't
work", "fix X on the previous ticket instead"), this is **feedback**: go to Step 5.
If they only want to change the model/effort of an existing ticket, go to Step 6.
Otherwise it is a **new ticket**: continue to Step 3.

## Step 3: Analyze and clarify (new ticket)

- Analyze the project code relevant to the request
- Ask as many rounds of questions as needed until the plan is complete and
  unambiguous. The agent that runs this ticket later is headless and will have **no
  way to ask the user anything** while it works, so over-clarifying beats
  under-clarifying.
- Then write a complete, detailed plan (this is the ticket body): context, goal,
  files involved, constraints, definition of done

## Step 3b: Propose a model and effort

After writing the plan and **before** creating the ticket, propose a model/effort
pair suited to the complexity, with a one-line justification:

- small mechanical change → `sonnet` / `medium`
- standard case → `opus` / `high` (the board default)
- large or delicate refactor → `opus` / `xhigh`

Allowed models: `opus`, `sonnet`, `haiku`, `fable`. Allowed efforts: `low`, `medium`,
`high`, `xhigh`, `max`. Let the user accept or change the proposal before going on.

## Step 4: Create the ticket

Write the JSON payload to a temporary file (to avoid any shell escaping issues),
for example `/tmp/kanban_ticket.json`:

```json
{
  "project_name": "<project name>",
  "project_path": "<absolute path>",
  "title": "<short ticket title>",
  "plan": "<full plan in markdown>",
  "model": "<opus|sonnet|haiku|fable>",
  "effort": "<low|medium|high|xhigh|max>"
}
```

Omit `model` and `effort` to keep the board default (`opus` / `high`).

Then:

```bash
curl -s -X POST http://127.0.0.1:8787/api/tickets \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/kanban_ticket.json
```

The project is created on the board automatically if it does not exist yet.
Confirm to the user that the ticket was created (with its id) and that it will show
up in "To do". Do not go to Step 5.

## Step 5: Feedback on an existing ticket (rejected after testing)

Ask for the ticket number if you don't have it yet. Ask the user exactly what is
wrong. Write the message to a temporary file, then:

```json
{ "message": "<precise, step-by-step explanation of what is wrong>" }
```

```bash
curl -s -X POST http://127.0.0.1:8787/api/tickets/<id>/feedback \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/kanban_feedback.json
```

This feedback is appended to the ticket's full history (nothing is ever overwritten)
and the ticket goes back to "To do", to be reprocessed with all that context.

## Step 6: Change the model/effort of an existing ticket

Ask for the ticket number and the new values. Not allowed while the ticket is "In
progress", "To commit" or "Done" (HTTP 409); otherwise it applies to the next run or
resume.

```bash
curl -s -X PATCH http://127.0.0.1:8787/api/tickets/<id>/settings \
  -H "Content-Type: application/json" \
  -d '{"model": "sonnet", "effort": "medium"}'
```

An omitted field is left unchanged; `null` goes back to the default.

## Notes

- The board runs locally on `http://127.0.0.1:8787` and does not start on its own:
  the user runs `./run.sh` from the claude-kanban folder. If the `curl` call fails
  (connection refused), tell the user clearly: the app is probably not running.
- Never launch a sub-agent or `claude -p` yourself: that is the application
  scheduler's job, not yours in this command.
