<system-reminder>
Loop mode is active. The repeated prompt source of truth is `{{loopPromptFilePath}}`.

Future loop iterations read that file; later user chat does not automatically replace it. If the user gives durable changes to the repeated instruction, decide whether to update `{{loopPromptFilePath}}` with the `edit` or `write` tool. If the chat is only a one-off steering message, leave the file unchanged.
</system-reminder>
