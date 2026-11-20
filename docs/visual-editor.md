# Visual Flow editor

Besides describing a Flow in words, you can build or change one by hand on **Flows → Build a Flow visually**, or **Edit visually** on a Flow you own.

- **Palette** (left): every action of the approved modules, plus *Sign-off* and *Wait*. Drag one onto the canvas where it should go, or press **+** to add it at the end.
- **Canvas** (middle): the steps in order. Drag a step to move it, or use the arrow buttons. **×** removes it.
- **Selected step** (right): a form made from the action's input schema. **Use…** fills a field from the run form (`{{ inputs.release }}`) or from an earlier step's output (`{{ steps.mrs.output.mergeRequests }}`, or how many there are). **Repeat for each item of** runs the action once per item of an earlier list; use `{{ item.<field> }}` for the current item.
- **Run form**: the inputs people fill in when they run the Flow (text, number, whole number, yes/no; required or not).

Saving creates a draft version (a new Flow, or a new version of this one), which still needs an approver. The server validates it like any other Flow; problems are shown under the editor. Step kinds the editor has no form for (AI, browser checks, app builds, Super Flow steps) are kept as they are and can still be moved; change them by asking for a revision in words.
