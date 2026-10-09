# tell-a-joke

Test bench: asks the agent for one short joke about `topic`. Touches nothing.

| | |
| --- | --- |
| Kind | prompt |
| Inputs | `topic` |
| Output | `{ setup, punchline }` |
| Eval | rejects a punchline that repeats the setup, and lines over 140 characters; max 2 |
| Used by | `bench` |
