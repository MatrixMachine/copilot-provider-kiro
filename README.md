# Copilot Provider - Kiro

A VS Code extension that registers Kiro (AWS CodeWhisperer/Q) AI models as language model providers for GitHub Copilot.

[中文文档](./README.zh-CN.md)

## Features

- Provides 12+ Kiro models for VS Code Copilot Chat
- Supports multiple authentication methods: AWS Builder ID, IAM Identity Center (SSO)
- Auto-discovers existing credentials from Kiro IDE / kiro-cli
- Automatic token refresh
- Tool Use support
- Streaming responses

## Supported Models

| Model | Family | Context | Features |
|-------|--------|---------|----------|
| Claude Opus 4.8 | claude-opus | 1M | Reasoning, Vision |
| Claude Opus 4.7 | claude-opus | 1M | Reasoning, Vision |
| Claude Opus 4.6 | claude-opus | 1M | Reasoning, Vision |
| Claude Sonnet 4.6 | claude-sonnet | 1M | Reasoning, Vision |
| Claude Sonnet 4.5 | claude-sonnet | 200K | Reasoning, Vision |
| Claude Sonnet 4 | claude-sonnet | 200K | Reasoning, Vision |
| Claude Haiku 4.5 | claude-haiku | 200K | Vision |
| DeepSeek 3.2 | deepseek | 164K | Reasoning |
| MiniMax M2.5 | minimax | 196K | - |
| MiniMax M2.1 | minimax | 196K | - |
| GLM 5 | glm | 200K | Reasoning |
| Qwen3 Coder Next | qwen | 256K | Reasoning |
| Auto | auto | 1M | Routing |

## Installation

1. Clone the repository and install dependencies:
```bash
git clone https://github.com/your-repo/copilot-provider-kiro.git
cd copilot-provider-kiro
npm install
npm run build
```

2. Press F5 in VS Code to launch the Extension Development Host

## Authentication

The extension auto-detects credentials from the following sources (in priority order):

1. **Kiro IDE Token** — `~/.aws/sso/cache/kiro-auth-token.json`
2. **kiro-cli Social Token** — Google/GitHub token from kiro-cli SQLite database
3. **kiro-cli IDC Token** — Builder ID/IDC token from kiro-cli SQLite database

If no existing credentials are found, use the `Kiro: Login` command to authenticate manually.

## Commands

- `Kiro: Login` — Start device code authentication flow
- `Kiro: Logout` — Clear stored credentials
- `Kiro: Show Status` — Display current authentication status

## Usage

Once authenticated, Kiro models will automatically appear in the Copilot Chat model picker. You can configure the default model in settings:

```json
{
  "copilot-provider-kiro.defaultModel": "claude-sonnet-4",
  "copilot-provider-kiro.modelAliases": {
    "deepseek-3-2": "DeepSeek Chat (Custom)",
    "qwen3-coder-next": "Qwen Plus (Team)"
  }
}
```

`copilot-provider-kiro.modelAliases` sets display aliases (right side value) for fixed VS Code model IDs (left side key). The actual model ID sent to the Kiro API remains unchanged.

## Development

```bash
npm run watch   # Auto-build during development
npm run check   # TypeScript type checking
npm run build   # Production build
```

## Project Structure

```
src/
├── extension.ts      # Extension entry point, model registration
├── provider.ts       # Language Model Provider implementation
├── auth.ts           # Authentication management (IDE/CLI/Device Code)
├── models.ts         # Model definitions
├── transform.ts      # Message format transformation
└── event-parser.ts   # Kiro stream event parser
```

## License

MIT
