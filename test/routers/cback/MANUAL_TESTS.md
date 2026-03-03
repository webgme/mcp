# GMEBot — Manual Chat Test Scenarios

## Setup

1. Start MongoDB and the WebGME server (`npm start`).
2. Start Ollama locally (`ollama serve`) with the model pulled (`ollama pull llama3.1:8b`).
3. Open `http://localhost:8888` in a browser, log in, and open any project.
4. Click the **GMEBot** button in the footer to open the chat dialog.

---

## Test 1: listSeeds — direct request

**Prompt:** `What seeds are available?`

**Expected:** The bot replies referencing available seeds. Since the tool is a stub,
it should indicate that the list is empty or that no seeds were found.

---

## Test 2: listSeeds — indirect request

**Prompt:** `I want to start a new project. What templates can I choose from?`

**Expected:** The bot recognises this as a seed-listing request, invokes `listSeeds`,
and replies about the available templates/seeds (empty for now).

---

## Test 3: createProject — with a name

**Prompt:** `Create a new project called MyStateMachine.`

**Expected:** The bot invokes `createProject` with `projectName: "MyStateMachine"`.
Since the tool is a stub, the reply should acknowledge the attempt and mention
that project creation is not yet implemented.

---

## Test 4: createProject — with name and seed

**Prompt:** `Create a project called DigitalTwin using the DSS seed.`

**Expected:** The bot invokes `createProject` with `projectName: "DigitalTwin"` and
`seedName: "DSS"`. The reply should indicate that creation is not yet implemented.

---

## Test 5: createProject — missing name

**Prompt:** `Create a new project.`

**Expected:** The bot either asks for a project name before calling the tool, or calls
the tool and relays the error. Either way the user should understand that a name is
needed.

---

## Test 6: chained tools — list then create

**Prompt:** `Show me the available seeds, then create a project called Demo from the first one.`

**Expected:** The bot calls `listSeeds` first. Since seeds are empty, it should tell
the user there are no seeds to choose from rather than blindly calling `createProject`.

---

## Test 7: listProjects — direct request

**Prompt:** `What projects do I have?`

**Expected:** The bot invokes `listProjects` and replies with the accessible projects.
Each project should be presented with its display name (e.g. `guest / MyProject`).
If no projects exist, the bot should say so.

---

## Test 8: listProjects — shows owner disambiguation

**Prerequisite:** Multiple projects exist with the same name under different owners
(e.g. `guest+Demo` and `admin+Demo`).

**Prompt:** `List my projects.`

**Expected:** The bot lists both projects with their owner prefixed (e.g.
`guest / Demo` and `admin / Demo`), making it clear they are different projects.
If the user asks to switch to "Demo", the bot should ask which owner's project
they mean, or use `listProjects` to resolve the ambiguity.

---

## Test 9: switchProject — with a project ID

**Prompt:** `Switch to the project guest+MyStateMachine.`

**Expected:** The bot invokes `switchProject` with `projectId: "guest+MyStateMachine"`.
The reply should acknowledge the switch. Additionally, a bracketed client message
should appear in the chat:
`[Switching to project guest+MyStateMachine is not wired up yet]`.
This confirms the backend returned a `switchProject` command and the widget received it.

---

## Test 10: switchProject — by name without ID format

**Prompt:** `Open the DigitalTwin project.`

**Expected:** The bot either calls `switchProject` with a best-guess project ID, or
first calls `listProjects` to find the matching ID. A `switchProject` command should
arrive at the widget (visible as a bracketed message). Since `listProjects` returns
empty, the bot may report that it could not find the project.

---

## Test 11: switchProject — unknown project

**Prompt:** `Switch to a project called DoesNotExist.`

**Expected:** The bot attempts the switch. A `switchProject` command reaches the
widget. Once project validation is implemented, this should report the project was
not found. For now, the bracketed "not wired up" message confirms the command path
works.

---

## Test 12: chained tools — list projects then switch

**Prompt:** `List my projects and switch to the first one.`

**Expected:** The bot calls `listProjects` first. Since the list is empty, it should
tell the user there are no projects to switch to rather than blindly calling
`switchProject`. No `switchProject` command should appear in this case.

---

## Test 13: non-tool conversation

**Prompt:** `What is WebGME?`

**Expected:** The bot answers with a general explanation about WebGME without invoking
any tools. No tool-call activity should appear in the server log.

---

## Test 14: context memory

**Prompt 1:** `Create a project called AlphaModel.`
*(wait for reply)*

**Prompt 2:** `What was the name of the project I just asked you to create?`

**Expected:** The bot replies referencing "AlphaModel", demonstrating that conversation
context is retained across turns.
