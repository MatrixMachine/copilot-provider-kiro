# Copilot Provider - Kiro

VS Code 扩展，将 Kiro (AWS CodeWhisperer/Q) 的 AI 模型注册为 GitHub Copilot 的语言模型提供者。

## 功能

- 为 VS Code Copilot Chat 提供 12+ 个 Kiro 模型
- 支持多种认证方式：AWS Builder ID、IAM Identity Center (SSO)
- 自动从 Kiro IDE / kiro-cli 发现已有凭证
- 自动刷新 token
- 支持工具调用 (Tool Use)
- 流式响应

## 支持的模型

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

## 安装

1. 克隆仓库并安装依赖：
```bash
git clone https://github.com/your-repo/copilot-provider-kiro.git
cd copilot-provider-kiro
npm install
npm run build
```

2. 在 VS Code 中按 F5 启动扩展开发宿主

## 认证

扩展会自动尝试以下认证来源（按优先级）：

1. **Kiro IDE Token** — `~/.aws/sso/cache/kiro-auth-token.json`
2. **kiro-cli Social Token** — kiro-cli SQLite 数据库中的 Google/GitHub 令牌
3. **kiro-cli IDC Token** — kiro-cli SQLite 数据库中的 Builder ID/IDC 令牌

如果没有找到已有凭证，使用 `Kiro: Login` 命令手动认证。

## 命令

- `Kiro: Login` — 启动设备代码认证流程
- `Kiro: Logout` — 清除已存储的凭证
- `Kiro: Show Status` — 显示当前认证状态

## 使用

认证成功后，Kiro 模型会自动出现在 Copilot Chat 的模型选择器中。你可以在设置中配置默认模型：

```json
{
  "copilot-provider-kiro.defaultModel": "claude-sonnet-4",
  "copilot-provider-kiro.modelAliases": {
    "deepseek-3-2": "DeepSeek Chat (Custom)",
    "qwen3-coder-next": "Qwen Plus (Team)"
  }
}
```

`copilot-provider-kiro.modelAliases` 用于给固定的 VS Code 模型 ID（左侧 key）设置显示别名（右侧 value）。实际发送到 Kiro API 的模型 ID 保持不变。

## 开发

```bash
npm run watch   # 开发时自动构建
npm run check   # TypeScript 类型检查
npm run build   # 生产构建
```

## 项目结构

```
src/
├── extension.ts      # 扩展入口，注册模型
├── provider.ts       # Language Model Provider 实现
├── auth.ts           # 认证管理（IDE/CLI/Device Code）
├── models.ts         # 模型定义
├── transform.ts      # 消息格式转换
└── event-parser.ts   # Kiro 流事件解析
```

## 许可证

MIT
