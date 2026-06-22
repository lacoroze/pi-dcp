# pi-dcp-stable

A local pi-coding-agent extension package that ports Dynamic Context Pruning (DCP) to pi.

This package is based on the behavior of the original OpenCode DCP project, [`Opencode-DCP/opencode-dynamic-context-pruning`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning). It was ported to pi's extension API with help from an LLM.

The port keeps the main DCP ideas: compressing old or closed conversation ranges, pruning duplicated or errored tool output, and providing the `/dcp` command flow in pi. It also adds small lookup tools for searching compressed context when a summary is not enough.

- `dcp_expand_block`: retrieve focused raw snippets from a compressed DCP block
- `dcp_search_compressed_raw`: search raw history inside one or more compressed DCP blocks

These lookup tools are only helpers. They do not replace compression summaries; they are meant for cases where a model needs a specific detail from already-compressed context.

## Install

Install from GitHub with pi:

```bash
pi install https://github.com/lacoroze/pi-dcp
```

After installing or updating the package, restart pi or run `/reload`.

## Commands

The main command is `/dcp`.

```text
/dcp context
/dcp stats
/dcp manual [on|off]
/dcp compress [focus]
/dcp decompress [N]
/dcp recompress [N]
/dcp sweep [N]
```

`/dcp-stable` is kept as a compatibility alias.

## Config

Global config:

```text
~/.config/pi/dcp-stable.jsonc
```

Project override:

```text
.pi/dcp-stable.jsonc
```

## Notes

- This is a pi-oriented port, not the upstream OpenCode package itself.
- The original DCP project remains the upstream reference for the core idea and behavior.
- This package includes pi-specific guardrails so context pruning does not interfere with final answers.
