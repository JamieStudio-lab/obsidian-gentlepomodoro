# Dataview 0.5.68, for the tests

`main.js` is Dataview 0.5.68's bundle exactly as its release ships it (sha1
`ada06164ae4cfba6d75721cf884a953a0acd7801`), and `LICENSE.txt` its licence (MIT,
Copyright (c) 2021 Michael Brenan), from the `0.5.68` tag of
https://github.com/blacksmithgu/obsidian-dataview.

It is not part of the plugin and never built into it. `tests/dataviewEngine.ts`
reads it as text and runs Dataview's own query parser, evaluator, DataviewJS API
and file worker over made-up notes, so `tests/dataviewEngine.test.ts` can run the
code the settings' Copy buttons give (logQueries.ts) in the engine that will
draw it. Kept byte for byte, so lint, prettier and tsc leave this folder alone.

To move to a later Dataview: replace both files from its release and tag, update
the sha1 in `tests/dataviewEngine.test.ts`, and run the suite — a change in what
the engine does shows there as a changed count.
