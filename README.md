# pi-dcp-stable

Dynamic Context Pruning (DCP) extension for pi.

This package is a pi-native port of opencode DCP behavior. It keeps the safer pi-specific guardrails that prevent final-answer hijacking, but its default pruning UX now mirrors opencode more closely:

- housekeeping nudges are enabled by default;
- new user turns above the min context threshold ask the model to evaluate compressible ranges;
- the turn nudge explicitly says to compress earlier ranges when direction has shifted;
- long iteration after the last user message gets a separate iteration nudge;
- compression notifications default to detailed chat-style DCP messages;
- `/dcp` is the primary command, with `/dcp-stable` kept as an alias;
- opencode-compatible config keys such as `compress.showCompression`, `compress.summaryBuffer`, `compress.nudgeForce`, and `pruneNotificationType` are accepted.

## Install locally

```bash
pi install ./pi-dcp-stable
```

Restart pi or run `/reload` after changing packages.

## Config

Global config is auto-created at:

```text
~/.config/pi/dcp-stable.jsonc
```

Project config override:

```text
.pi/dcp-stable.jsonc
```

Defaults intentionally mirror opencode DCP's normal pruning behavior:

```jsonc
{
  "manualMode": {
    "enabled": false,
    "automaticStrategies": true,
    "allowCriticalNudge": true,
  },
  "compress": {
    "autonomous": "housekeeping", // off | critical | housekeeping
    "mode": "range",
    "permission": "allow",
    "showCompression": false,
    "summaryBuffer": true,
    "maxContextLimit": 100000,
    "minContextLimit": 50000,
    "nudgeFrequency": 5,
    "iterationNudgeThreshold": 15,
    "nudgeForce": "soft",
    "protectedTools": ["task", "skill", "todo", "todoread", "todowrite"],
    "protectUserMessages": false,
  },
  "strategies": {
    "deduplication": { "enabled": true, "protectedTools": [] },
    "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] },
  },
  "pruneNotification": "detailed",
  "pruneNotificationType": "chat",
}
```

For maximum safety, set:

```jsonc
{
  "compress": { "autonomous": "off" },
  "manualMode": { "enabled": true },
}
```

## Commands

Use `/dcp`:

- `/dcp context`
- `/dcp stats`
- `/dcp manual [on|off]`
- `/dcp compress [focus]`
- `/dcp decompress [N]`
- `/dcp recompress [N]`
- `/dcp sweep [N]`

`/dcp-stable` remains a compatibility alias.

## Tools

Registers a `compress` tool compatible with range-compression workflow:

```json
{
  "topic": "Short Topic",
  "ranges": [{ "startId": "m001", "endId": "m042", "summary": "..." }]
}
```

Nested blocks that are fully covered by a new range are deactivated after their placeholders are expanded into the new summary. Partial overlaps are rejected.

Compression result notifications include opencode-style metrics such as removed tokens, active summary tokens, item counts, and optionally the compression text when `compress.showCompression` is true.

Also registers targeted raw-history lookup tools for compressed blocks:

- `dcp_expand_block({ blockId, query?, maxChars? })`: expands a visible DCP block such as `b2` into targeted raw snippets from the current session branch. Use a `query` when possible.
- `dcp_search_compressed_raw({ query, blockId?, limit?, maxChars? })`: searches raw messages inside one or all compressed DCP blocks.

These lookup tools do not replace the visible DCP summaries. They are intended for the model to call only when an existing compressed summary is insufficient and it needs specific details from the raw session history.
