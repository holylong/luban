# First-run default configuration

`src/core/default-config.ts` is the portable starter, not a copy of a developer's
working `~/.luban/config.json`. CLI first-run loading creates the file only when
absent. Existing files, including explicit restrictions and model choices, are
never rewritten. Library callers do not seed a file unless requested. Creation
uses exclusive publication and owner-only permissions on Unix.

## Portable settings included

- The built-in credential-free OpenCode Zen model and generation settings.
  `model.max_tokens: 128000` is the client's output ceiling, so a first install
  asks for the largest response it can get instead of a conservative budget that
  reasoning models burn before writing anything; the loader defaults to the same
  value, and a provider that rejects it is halved automatically (`usageDetails` /
  `noteOutputCeiling` in `src/core/openai.ts`). It is not an authentication token.
  Provider catalogs remain built in.
- Mesh bind ports, sync exclusions and conflict policy, worker and step limits.
- Existing sandbox and approval policy: soft sandbox, outside-workspace access
  enabled, and `permission.mode: edits`. This is not a strict isolation template;
  shell/network approval is retained. Computer control retains its existing
  enabled setting, subject to platform permissions and runtime controls.
- Interaction logging remains disabled.
- Empty `contacts: []` and `projects: {}` placeholders, containing no peer
  identities, addresses, project names or filesystem paths.
- `remote.enabled: false`, loopback host and ephemeral port. No relay endpoint,
  credentials, credential-file path or environment-variable binding is copied.
  These values do not themselves start a web server or relay connection.
- `kev.mode: model`, empty URL and a 120-second timeout. There is no supported
  `kev.enabled` flag: selecting the model decision engine and omitting the URL
  leaves the external advisor unconfigured. Explicit environment configuration
  can still supply a URL; the starter is not an environment-policy override.

## Intentionally excluded

| Category | Why it is not copied |
| --- | --- |
| Provider definitions and model catalogs | Account-specific gateways, keys and model overrides must not ship; built-in catalogs stay current. |
| `model.api_key`, `api_key_env`, `base_url`, legacy `model.model` | Credentials/bindings/endpoints are user-owned; `model.active` selects the portable built-in model instead. |
| `node.name` | The loader derives the local identity rather than shipping someone else's hostname. |
| `node.capabilities` | Derived at runtime from OS and available facilities; a static list could advertise another machine's capabilities. |
| Contacts and projects entries | Peer names/hosts/notes and workspace paths are private and machine-specific. Only empty containers ship. |
| Remote relay URLs, tokens, token files and CA paths | Deployment-specific trust and authentication must be explicitly configured. |
| Kev URL, API key and model override | External advisor deployment and authentication are user-owned. Loader defaults supply the model name. |
| MCP servers | Commands, arguments, environment, headers, working directories and URLs can execute code or contain secrets. No developer server is copied. |
| LSP/custom executable settings | Executable availability and paths vary by installation; use runtime discovery or explicit local configuration. |

## Unsupported or non-default settings

A top-level `web` block in a working config is not consumed by `loadConfig` or the
CLI's web listener selection. Use `luban web --host ... --port ...` (see CLI help),
not a starter `web.host`/`web.port` block. Browser authentication comes from
`--token`, `LUBAN_WEB_TOKEN`, or runtime token generation, not a shipped top-level
`token`. The workspace comes from the CLI path/current directory, not a shipped
`workspace` field.

MCP is supported through `mcp.servers`, `mcpServers` or `mcp_servers`, with
`mcp.max_tools` and `mcp.lazy` tuning. Those fields are not needed for an empty
installation; an arbitrary `mcp` block does not imply that all its fields work.
The starter intentionally omits it rather than freezing optional tuning or
copying commands. Unknown/no-op settings are not made defaults merely because
they occur in a local configuration.

The comparison used only local key names and value types; no local credential,
endpoint, contact, project path or MCP command was printed or imported. Tests
exercise generated first-run loading, empty private-data containers, absent
credential fields, runtime capabilities and preservation of existing files.
